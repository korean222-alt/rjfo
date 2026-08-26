import type { Bar } from "@/types";
import { kvGet, kvSet } from "@/lib/kv";
import { DataProviderError, isCryptoTicker } from "./provider";

/**
 * 코인 펀딩비 — API 키 없이 거래소 공개 히스토리.
 * 8시간 정산값을 날짜별 평균으로 붙여 거래량과 같은 일봉 조건으로 쓴다.
 */

const TIMEOUT_MS = 10_000;
const CACHE_SECONDS = 6 * 60 * 60;

const INST: Record<string, { mexc: string; okx: string }> = {
  "BTC-USD": { mexc: "BTC_USDT", okx: "BTC-USDT-SWAP" },
  "ETH-USD": { mexc: "ETH_USDT", okx: "ETH-USDT-SWAP" },
  "SOL-USD": { mexc: "SOL_USDT", okx: "SOL-USDT-SWAP" },
  "XRP-USD": { mexc: "XRP_USDT", okx: "XRP-USDT-SWAP" },
  "DOGE-USD": { mexc: "DOGE_USDT", okx: "DOGE-USDT-SWAP" },
  "ADA-USD": { mexc: "ADA_USDT", okx: "ADA-USDT-SWAP" },
};

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

  const points: Point[] = [];
  const attempts = [() => fromMexc(inst.mexc), () => fromOkx(inst.okx)];
  for (const run of attempts) {
    try {
      points.push(...(await run()));
    } catch {
      // 한쪽이 막혀도 다른 쪽만으로 분석한다.
    }
  }
  const daily = toDailyFunding(points);
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
