import type { Bar } from "@/types";
import { DataProviderError, type DataProvider } from "./provider";

/**
 * Stooq CSV 폴백 소스.
 *
 * Yahoo가 데이터센터 IP를 429로 막을 때를 위한 두 번째 소스다.
 * API 키가 필요 없고 일봉 전체 히스토리를 CSV 한 방에 준다.
 *   https://stooq.com/q/d/l/?s=nvda.us&i=d
 *   Date,Open,High,Low,Close,Volume   (오래된 순)
 *
 * 주의: Stooq는 분할 조정된 값을 주지만 배당 조정은 하지 않는다.
 * 거래량 기준 필터가 목적이므로 실사용에 문제는 없고, Yahoo가 살아 있으면
 * 항상 Yahoo가 우선한다.
 */

const BASE = "https://stooq.com/q/d/l/";
const TIMEOUT_MS = 8_000;

/** 티커.접미사 형태에서 '거래소 접미사'로 인정할 것들 (그 외의 점은 클래스 구분자). */
const EXCHANGE_SUFFIXES = new Set([
  "US", "UK", "DE", "F", "PL", "HU", "JP", "T", "HK", "SS", "SZ",
  "KS", "KQ", "L", "PA", "MI", "AS", "SW", "TO", "V", "AX", "SI", "NS", "BO",
]);

/** Yahoo 스타일 지수 티커 → Stooq 지수 심볼. */
const INDEX_MAP: Record<string, string> = {
  "^GSPC": "^spx",
  "^SPX": "^spx",
  "^DJI": "^dji",
  "^IXIC": "^ndq",
  "^NDX": "^ndx",
  "^RUT": "^rut",
  "^VIX": "^vix",
  "^KS11": "^kospi",
  "^KQ11": "^kosdaq",
  "^N225": "^nkx",
  "^FTSE": "^ukx",
  "^GDAXI": "^dax",
};

/** Yahoo 티커를 Stooq 심볼로 옮긴다. (BRK.B → brk-b.us, 005930.KS → 005930.ks) */
export function toStooqSymbol(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  if (t.startsWith("^")) return INDEX_MAP[t] ?? t.toLowerCase();

  const dot = t.lastIndexOf(".");
  if (dot > 0) {
    const head = t.slice(0, dot);
    const tail = t.slice(dot + 1);
    if (EXCHANGE_SUFFIXES.has(tail)) return `${head}.${tail}`.toLowerCase();
    // BRK.B 같은 주식 클래스는 Stooq에서 하이픈으로 쓴다.
    return `${head}-${tail}.us`.toLowerCase();
  }
  return `${t.toLowerCase()}.us`;
}

/** Stooq CSV → Bar[]. 헤더 순서가 바뀌어도 되도록 컬럼명으로 인덱스를 잡는다. */
export function parseStooqCsv(csv: string): Bar[] {
  const lines = csv.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iDate = col("date");
  const iOpen = col("open");
  const iHigh = col("high");
  const iLow = col("low");
  const iClose = col("close");
  const iVol = col("volume");
  if (iDate < 0 || iOpen < 0 || iHigh < 0 || iLow < 0 || iClose < 0 || iVol < 0) {
    return [];
  }

  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    const date = (f[iDate] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const open = Number(f[iOpen]);
    const high = Number(f[iHigh]);
    const low = Number(f[iLow]);
    const close = Number(f[iClose]);
    const volume = Number(f[iVol]);
    if (![open, high, low, close, volume].every((n) => Number.isFinite(n))) continue;
    if (close <= 0 || volume < 0) continue;

    bars.push({ date, open, high, low, close, volume });
  }

  // Stooq는 오래된 순으로 주지만 보장은 없으니 한 번 정렬한다.
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return bars;
}

export class StooqProvider implements DataProvider {
  readonly name = "stooq";

  async getDailyBars(ticker: string, years: number): Promise<Bar[]> {
    const symbol = toStooqSymbol(ticker);
    const url = `${BASE}?s=${encodeURIComponent(symbol)}&i=d`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/csv,text/plain,*/*",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new DataProviderError(
        `보조 시세 서버에 연결하지 못했습니다: ${(e as Error).message}`,
        502,
      );
    }

    if (!res.ok) {
      throw new DataProviderError(
        `보조 시세 서버 오류 (HTTP ${res.status}).`,
        res.status === 429 ? 429 : 502,
      );
    }

    const text = await res.text();
    // 한도 초과·없는 심볼일 때 CSV 대신 안내 문구/HTML이 온다.
    if (/exceeded the daily hits limit/i.test(text)) {
      throw new DataProviderError("보조 시세 서버 일일 한도를 초과했습니다.", 429);
    }
    if (/^\s*</.test(text) || /no data/i.test(text)) {
      throw new DataProviderError(`'${ticker}' 보조 소스에도 데이터가 없습니다.`, 404);
    }

    const all = parseStooqCsv(text);
    if (!all.length) {
      throw new DataProviderError(`'${ticker}' 보조 소스에도 데이터가 없습니다.`, 404);
    }

    // 요청한 기간만 남긴다 (Stooq는 상장 이후 전체를 준다).
    const cutoffMs = Date.now() - years * 366 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
    const bars = all.filter((b) => b.date >= cutoff);
    return bars.length ? bars : all;
  }
}
