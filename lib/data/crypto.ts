import type { Bar } from "@/types";
import { DataProviderError, type DataProvider } from "./provider";

/**
 * 코인 일봉 — API 키 없이 거래소 공개 시세.
 *
 * Twelve Data 무료 플랜은 BTC/USD 가격은 주지만 volume이 전부 0이다.
 * 거래량 분석기가 그걸 그대로 쓰면 신호가 한 건도 안 나온다.
 * OKX(호가금액 volCcyQuote) → Coinbase 순으로 받는다.
 *
 * 기간 주의 (사이클 차트가 2018년부터 시작하던 이유):
 *  OKX의 BTC-USDT 현물은 2018년 초에 상장됐다. 그래서 20년치를 달라고 해도
 *  OKX가 줄 수 있는 건 2018년부터다. Coinbase도 2015년 7월이 처음이고,
 *  그보다 앞선 구간(BTC가 한 자릿수 달러이던 시절)은 어느 쪽에도 없다.
 *  Bitstamp는 BTC/USD를 2011년 8월부터 거래량까지 같이 준다. 그래서
 *  주 소스가 시작하는 날짜보다 앞선 구간만 Bitstamp로 채워 붙인다.
 */

const TIMEOUT_MS = 12_000;

const CRYPTO: Record<string, { okx: string; coinbase: string }> = {
  "BTC-USD": { okx: "BTC-USDT", coinbase: "BTC-USD" },
  "ETH-USD": { okx: "ETH-USDT", coinbase: "ETH-USD" },
  "SOL-USD": { okx: "SOL-USDT", coinbase: "SOL-USD" },
  "XRP-USD": { okx: "XRP-USDT", coinbase: "XRP-USD" },
  "DOGE-USD": { okx: "DOGE-USDT", coinbase: "DOGE-USD" },
  "ADA-USD": { okx: "ADA-USDT", coinbase: "ADA-USD" },
};

/**
 * 주 소스보다 히스토리가 긴 보조 소스 (Bitstamp 페어).
 * BTC 2011-08, ETH 2016-08, XRP 2017-01 — 각 코인이 실제로 거래되기 시작한 시점에 가깝다.
 * 상장이 최근인 코인(SOL·DOGE·ADA)은 붙일 과거가 없어서 넣지 않는다.
 */
const LONG_HISTORY: Record<string, string> = {
  "BTC-USD": "btcusd",
  "ETH-USD": "ethusd",
  "XRP-USD": "xrpusd",
};

const TV_PERP: Record<string, string> = {
  "BTC-USD": "BINANCE:BTCUSDT.P",
  "ETH-USD": "BINANCE:ETHUSDT.P",
  "SOL-USD": "BINANCE:SOLUSDT.P",
  "XRP-USD": "BINANCE:XRPUSDT.P",
  "DOGE-USD": "BINANCE:DOGEUSDT.P",
  "ADA-USD": "BINANCE:ADAUSDT.P",
};

export function tradingViewPerpSymbol(ticker: string): string | null {
  return TV_PERP[ticker] ?? null;
}

export function isKnownCrypto(ticker: string): boolean {
  return ticker in CRYPTO;
}

/** 거래량 분석에 쓸 수 있는지. 코인은 절반 이상이 0이면 실패로 본다. */
export function hasUsableVolume(bars: Bar[]): boolean {
  if (bars.length < 60) return false;
  let nonzero = 0;
  for (const b of bars) if (b.volume > 0) nonzero++;
  return nonzero / bars.length >= 0.5;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new DataProviderError(`코인 시세 연결 실패: ${(e as Error).message}`, 502);
  }
  if (!res.ok) {
    throw new DataProviderError(`코인 시세 오류 (HTTP ${res.status}).`, res.status === 429 ? 429 : 502);
  }
  return res.json();
}

/**
 * 하루 안에서 고가/저가가 100배 넘게 벌어지는 봉은 시세가 아니라 데이터 사고다.
 *
 * 신규 상장 첫날은 호가창이 비어 있어서 거래소가 0에 가까운 체결가를 한 번 찍고,
 * 그게 그대로 일봉의 시가·저가가 된다. 로그 축 차트에서는 그 한 봉 때문에
 * 가격 축이 0.05까지 늘어나 나머지 십수 년이 납작해진다.
 */
function isBrokenBar(open: number, high: number, low: number, close: number): boolean {
  if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) return true;
  return Math.max(open, high, close) / Math.min(open, low, close) > 100;
}

export function toUniqueBars(rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>): Bar[] {
  const byDate = new Map<string, Bar>();
  for (const row of rows) {
    const { date, open, high, low, close, volume } = row;
    if (!Number.isFinite(volume) || volume < 0) continue;
    if (isBrokenBar(open, high, low, close)) continue;
    byDate.set(date, { date, open, high, low, close, volume });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 주 소스 앞에 더 오래된 소스를 이어 붙인다.
 *
 * 겹치는 구간은 언제나 주 소스를 쓴다 (거래량 기준이 그쪽에 맞춰져 있다).
 * older에서 가져오는 건 주 소스의 첫 봉보다 앞선 날짜뿐이다.
 */
export function mergeOlderHistory(recent: Bar[], older: Bar[]): Bar[] {
  if (!recent.length) return older;
  if (!older.length) return recent;
  const from = recent[0].date;
  const head = older.filter((b) => b.date < from);
  return head.length ? [...head, ...recent] : recent;
}

async function fromOkx(inst: string, years: number): Promise<Bar[]> {
  const cutoff = Date.now() - Math.ceil(years * 366 * 24 * 60 * 60 * 1000);
  const rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  let after: string | null = null;

  for (let i = 0; i < 14; i++) {
    const url =
      `https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=1D&limit=300` +
      (after ? `&after=${after}` : "");
    const json = (await getJson(url)) as { code?: string; data?: string[][] };
    if (json.code !== "0" || !json.data?.length) break;
    for (const row of json.data) {
      const ts = Number(row[0]);
      // confirm(row[8])이 있으면 미완성 봉은 버린다. 알림이 당일 진행 중 봉을 보지 않게.
      if (row[8] === "0") continue;
      rows.push({
        date: utcDate(ts),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        // volCcyQuote(USDT 거래대금). 없으면 코인 수량 * 종가.
        volume: Number(row[7] ?? Number(row[5]) * Number(row[4])),
      });
    }
    const oldest = json.data[json.data.length - 1]?.[0];
    if (!oldest) break;
    after = oldest;
    if (Number(oldest) <= cutoff) break;
    if (json.data.length < 300) break;
  }
  return toUniqueBars(rows);
}

async function fromCoinbase(product: string, years: number): Promise<Bar[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - Math.ceil(years * 366 * 24 * 60 * 60);
  const rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  let cursor = start;
  while (cursor < end) {
    const next = Math.min(end, cursor + 300 * 86400);
    const url =
      `https://api.exchange.coinbase.com/products/${product}/candles` +
      `?granularity=86400&start=${new Date(cursor * 1000).toISOString()}&end=${new Date(next * 1000).toISOString()}`;
    const raw = (await getJson(url)) as unknown;
    if (Array.isArray(raw)) {
      for (const row of raw as unknown[]) {
        if (!Array.isArray(row) || row.length < 6) continue;
        const time = Number(row[0]);
        const low = Number(row[1]);
        const high = Number(row[2]);
        const open = Number(row[3]);
        const close = Number(row[4]);
        const baseVol = Number(row[5]);
        rows.push({
          date: utcDate(time * 1000),
          open,
          high,
          low,
          close,
          volume: baseVol * close,
        });
      }
    }
    cursor = next + 1;
  }
  return toUniqueBars(rows);
}

/**
 * Bitstamp OHLC. BTC/USD를 2011년 8월부터 준다 — 공개 API 중 가장 긴 일봉이다.
 *
 * start를 상장 이전으로 주면 거래소마다 동작이 갈려서, end를 옮겨가며 과거로 거슬러
 * 올라간다. 한 번에 1,000봉(최대)이라 15년치도 여섯 번이면 끝난다.
 * volume은 코인 수량이라 Coinbase와 같은 방식으로 종가를 곱해 달러 거래대금으로 맞춘다.
 */
async function fromBitstamp(pair: string, years: number): Promise<Bar[]> {
  const cutoff = Math.floor(Date.now() / 1000) - Math.ceil(years * 366 * 24 * 60 * 60);
  const rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  let end = Math.floor(Date.now() / 1000);

  for (let i = 0; i < 12; i++) {
    const url = `https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=86400&limit=1000&end=${end}`;
    const json = (await getJson(url)) as {
      data?: { ohlc?: Array<Record<"timestamp" | "open" | "high" | "low" | "close" | "volume", string>> };
    };
    const ohlc = json.data?.ohlc ?? [];
    if (!ohlc.length) break;

    let oldest = Infinity;
    for (const row of ohlc) {
      const ts = Number(row.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (ts < oldest) oldest = ts;
      const close = Number(row.close);
      rows.push({
        date: utcDate(ts * 1000),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close,
        volume: Number(row.volume) * close,
      });
    }

    // 한 페이지가 안 찼다는 건 상장일까지 다 받았다는 뜻이다.
    if (!Number.isFinite(oldest) || ohlc.length < 1000) break;
    if (oldest <= cutoff) break;
    end = oldest - 86400;
  }
  return toUniqueBars(rows);
}

/**
 * 주 소스가 요청한 기간을 다 못 채웠으면 Bitstamp로 앞을 메운다.
 * 보조 소스가 막혀도 주 소스 결과는 그대로 살린다 (있는 만큼이라도 보여준다).
 */
async function extendBack(ticker: string, bars: Bar[], years: number): Promise<Bar[]> {
  const pair = LONG_HISTORY[ticker];
  if (!pair || !bars.length) return bars;

  const wanted = utcDate(Date.now() - Math.ceil(years * 366 * 24 * 60 * 60 * 1000));
  if (bars[0].date <= wanted) return bars; // 이미 요청한 기간을 덮는다

  try {
    return mergeOlderHistory(bars, await fromBitstamp(pair, years));
  } catch {
    return bars;
  }
}

export class CryptoExchangeProvider implements DataProvider {
  readonly name = "crypto";

  async getDailyBars(ticker: string, years: number): Promise<Bar[]> {
    const inst = CRYPTO[ticker];
    if (!inst) {
      throw new DataProviderError(`'${ticker}'는 코인 시세 대상이 아닙니다.`, 422);
    }

    const pair = LONG_HISTORY[ticker];
    const attempts: Array<{ name: string; run: () => Promise<Bar[]> }> = [
      { name: "okx", run: () => fromOkx(inst.okx, years) },
      { name: "coinbase", run: () => fromCoinbase(inst.coinbase, years) },
      // 앞의 둘이 다 막혔을 때의 마지막 수단이자, 가장 긴 히스토리를 가진 소스.
      ...(pair ? [{ name: "bitstamp", run: () => fromBitstamp(pair, years) }] : []),
    ];

    let last: unknown = null;
    for (const { run } of attempts) {
      try {
        const bars = await run();
        if (hasUsableVolume(bars)) return await extendBack(ticker, bars, years);
        last = new DataProviderError(`코인 일봉 거래량이 비어 있습니다 (${bars.length}일).`, 422);
      } catch (e) {
        last = e;
      }
    }
    if (last instanceof DataProviderError) throw last;
    throw new DataProviderError(`코인 시세를 가져오지 못했습니다: ${(last as Error)?.message ?? "알 수 없음"}`, 502);
  }
}
