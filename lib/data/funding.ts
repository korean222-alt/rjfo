import type { Bar } from "@/types";
import { kvGet, kvSet } from "@/lib/kv";
import { DataProviderError, isCryptoTicker } from "./provider";

/**
 * 코인 펀딩비 — API 키 없이 거래소 공개 히스토리.
 * 8시간 정산값을 날짜별 평균으로 붙여 거래량과 같은 일봉 조건으로 쓴다.
 */

const TIMEOUT_MS = 10_000;
const CACHE_SECONDS = 6 * 60 * 60;

const INST: Record<string, { binance: string; mexc: string; okx: string }> = {
  "BTC-USD": { binance: "BTCUSDT", mexc: "BTC_USDT", okx: "BTC-USDT-SWAP" },
  "ETH-USD": { binance: "ETHUSDT", mexc: "ETH_USDT", okx: "ETH-USDT-SWAP" },
  "SOL-USD": { binance: "SOLUSDT", mexc: "SOL_USDT", okx: "SOL-USDT-SWAP" },
  "XRP-USD": { binance: "XRPUSDT", mexc: "XRP_USDT", okx: "XRP-USDT-SWAP" },
  "DOGE-USD": { binance: "DOGEUSDT", mexc: "DOGE_USDT", okx: "DOGE-USDT-SWAP" },
  "ADA-USD": { binance: "ADAUSDT", mexc: "ADA_USDT", okx: "ADA-USDT-SWAP" },
};

/**
 * 바이낸스 무기한선물이 시작한 무렵. 여기서부터 앞으로 훑는다.
 * 그 이전 펀딩비는 어느 소스에도 없다 — 상품 자체가 없었다.
 */
const BINANCE_START_MS = Date.UTC(2019, 8, 1);

/** 사이클을 두어 번이라도 덮으려면 이만큼은 있어야 채점할 값어치가 있다. */
const ENOUGH_DAYS = 300;

export function fundingInstrument(ticker: string) {
  return INST[ticker] ?? null;
}

type Point = { t: number; rate: number };

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new DataProviderError(`펀딩비 연결 실패: ${(e as Error).message}`, 502);
  }
  if (!res.ok) throw new DataProviderError(`펀딩비 오류 (HTTP ${res.status}).`, 502);
  return res.json();
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 8시간 펀딩을 UTC 날짜별 평균으로. */
export function toDailyFunding(points: Point[]): Map<string, number> {
  const buckets = new Map<string, number[]>();
  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.rate)) continue;
    const date = utcDate(p.t);
    const list = buckets.get(date);
    if (list) list.push(p.rate);
    else buckets.set(date, [p.rate]);
  }
  const out = new Map<string, number>();
  for (const [date, rates] of buckets) {
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    out.set(date, mean);
  }
  return out;
}

/**
 * 바이낸스 펀딩비 히스토리. 8시간마다 한 건, 2019-09부터.
 *
 * MEXC(최대 24페이지 × 100건 = 800일)·OKX(12 × 100 = 400일)보다 훨씬 길다. 사이클
 * 채점은 사이클이 몇 번 들어오느냐로 결정되므로, 이 차이가 등급을 매길 수 있느냐 없느냐를
 * 가른다. 그래서 이쪽을 1순위로 둔다.
 *
 * startTime을 밀어가며 앞으로 훑는다. limit 1000이면 하루 3건 × 6년 ≈ 7번이면 끝난다.
 */
async function fromBinance(symbol: string): Promise<Point[]> {
  const points: Point[] = [];
  let start = BINANCE_START_MS;
  const now = Date.now();

  for (let i = 0; i < 12; i++) {
    const rows = (await getJson(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&limit=1000`,
    )) as Array<{ fundingTime?: number; fundingRate?: string }>;
    if (!Array.isArray(rows) || !rows.length) break;

    for (const row of rows) {
      const t = Number(row.fundingTime);
      const rate = Number(row.fundingRate);
      if (Number.isFinite(t) && Number.isFinite(rate)) points.push({ t, rate });
    }

    const lastT = Number(rows[rows.length - 1]?.fundingTime);
    // 시간이 안 밀리면(응답이 이상하면) 무한 루프가 되므로 끊는다.
    if (!Number.isFinite(lastT) || lastT + 1 <= start) break;
    start = lastT + 1;
    if (rows.length < 1000 || start >= now) break;
  }
  return points;
}

async function fromMexc(symbol: string): Promise<Point[]> {
  const first = (await getJson(
    `https://contract.mexc.com/api/v1/contract/funding_rate/history?symbol=${symbol}&page_num=1&page_size=100`,
  )) as {
    success?: boolean;
    data?: { totalPage?: number; resultList?: Array<{ fundingRate: number; settleTime: number }> };
  };
  const list = first.data?.resultList ?? [];
  const totalPage = Math.min(first.data?.totalPage ?? 1, 24);
  const rest =
    totalPage > 1
      ? await Promise.all(
          Array.from({ length: totalPage - 1 }, (_, i) =>
            getJson(
              `https://contract.mexc.com/api/v1/contract/funding_rate/history?symbol=${symbol}&page_num=${i + 2}&page_size=100`,
            ),
          ),
        )
      : [];
  const points: Point[] = [];
  for (const row of list) points.push({ t: row.settleTime, rate: Number(row.fundingRate) });
  for (const page of rest) {
    const rows =
      (page as { data?: { resultList?: Array<{ fundingRate: number; settleTime: number }> } }).data
        ?.resultList ?? [];
    for (const row of rows) points.push({ t: row.settleTime, rate: Number(row.fundingRate) });
  }
  return points;
}

async function fromOkx(inst: string): Promise<Point[]> {
  const points: Point[] = [];
  let after: string | null = null;
  for (let i = 0; i < 12; i++) {
    const url =
      `https://www.okx.com/api/v5/public/funding-rate-history?instId=${inst}&limit=100` +
      (after ? `&after=${after}` : "");
    const json = (await getJson(url)) as {
      code?: string;
      data?: Array<{ fundingRate: string; fundingTime: string }>;
    };
    if (json.code !== "0" || !json.data?.length) break;
    for (const row of json.data) {
      points.push({ t: Number(row.fundingTime), rate: Number(row.fundingRate) });
    }
    after = json.data[json.data.length - 1]?.fundingTime ?? null;
    if (!after || json.data.length < 100) break;
  }
  return points;
}

export async function loadDailyFunding(ticker: string): Promise<Map<string, number>> {
  const inst = INST[ticker];
  if (!inst) return new Map();

  const cacheKey = `funding:${ticker}`;
  const cached = await kvGet(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Array<[string, number]>;
      if (Array.isArray(parsed) && parsed.length > 30) return new Map(parsed);
    } catch {
      // ignore
    }
  }

  // 소스를 섞지 않는다. 거래소마다 펀딩 수준이 조금씩 달라서, 긴 소스와 짧은 소스를
  // 합치면 겹치는 최근 구간만 평균이 되어 시계열에 계단이 생긴다. 60일 z-점수는 그
  // 계단을 '펀딩이 변했다'로 읽는다. 그래서 한 소스가 충분하면 거기서 멈춘다.
  const attempts: Array<[string, () => Promise<Point[]>]> = [
    ["binance", () => fromBinance(inst.binance)],
    ["mexc", () => fromMexc(inst.mexc)],
    ["okx", () => fromOkx(inst.okx)],
  ];

  let daily = new Map<string, number>();
  for (const [, run] of attempts) {
    try {
      const got = toDailyFunding(await run());
      if (got.size > daily.size) daily = got;
      if (daily.size >= ENOUGH_DAYS) break;
    } catch {
      // 한쪽이 막혀도 다음 소스로 넘어간다.
    }
  }
  if (daily.size >= 30) {
    await kvSet(cacheKey, JSON.stringify([...daily.entries()]), CACHE_SECONDS);
  }
  return daily;
}

export async function attachFunding(ticker: string, bars: Bar[]): Promise<Bar[]> {
  if (!isCryptoTicker(ticker) || !bars.length) return bars;
  try {
    const daily = await loadDailyFunding(ticker);
    if (!daily.size) return bars;
    return bars.map((b) => ({ ...b, funding: daily.has(b.date) ? daily.get(b.date)! : null }));
  } catch {
    return bars;
  }
}

export function fundingCoverage(bars: Bar[]): { days: number; first: string | null; last: string | null } {
  const have = bars.filter((b) => b.funding != null);
  return {
    days: have.length,
    first: have[0]?.date ?? null,
    last: have[have.length - 1]?.date ?? null,
  };
}
