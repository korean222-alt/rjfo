import type { Bar } from "@/types";
import { DataProviderError, type DataProvider } from "./provider";

/**
 * 코인 일봉 — API 키 없이 거래소 공개 시세.
 *
 * Twelve Data 무료 플랜은 BTC/USD 가격은 주지만 volume이 전부 0이다.
 * 거래량 분석기가 그걸 그대로 쓰면 신호가 한 건도 안 나온다.
 * OKX(호가금액 volCcyQuote) → Coinbase 순으로 받는다.
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

function toUniqueBars(rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>): Bar[] {
  const byDate = new Map<string, Bar>();
  for (const row of rows) {
    const { date, open, high, low, close, volume } = row;
    if (![open, high, low, close, volume].every((n) => Number.isFinite(n))) continue;
    if (close <= 0 || volume < 0) continue;
    byDate.set(date, { date, open, high, low, close, volume });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
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

export class CryptoExchangeProvider implements DataProvider {
  readonly name = "crypto";

  async getDailyBars(ticker: string, years: number): Promise<Bar[]> {
    const inst = CRYPTO[ticker];
    if (!inst) {
      throw new DataProviderError(`'${ticker}'는 코인 시세 대상이 아닙니다.`, 422);
    }

    const attempts: Array<{ name: string; run: () => Promise<Bar[]> }> = [
      { name: "okx", run: () => fromOkx(inst.okx, years) },
      { name: "coinbase", run: () => fromCoinbase(inst.coinbase, years) },
    ];

    let last: unknown = null;
    for (const { run } of attempts) {
      try {
        const bars = await run();
        if (hasUsableVolume(bars)) return bars;
        last = new DataProviderError(`코인 일봉 거래량이 비어 있습니다 (${bars.length}일).`, 422);
      } catch (e) {
        last = e;
      }
    }
    if (last instanceof DataProviderError) throw last;
    throw new DataProviderError(`코인 시세를 가져오지 못했습니다: ${(last as Error)?.message ?? "알 수 없음"}`, 502);
  }
}
