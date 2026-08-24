import type { Bar } from "@/types";
import { DataProviderError, type DataProvider } from "./provider";

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

type YahooSplit = { date: number; numerator: number; denominator: number };

type YahooChart = {
  chart: {
    error: { code: string; description: string } | null;
    result:
      | [
          {
            timestamp?: number[];
            indicators: {
              quote: [
                {
                  open?: (number | null)[];
                  high?: (number | null)[];
                  low?: (number | null)[];
                  close?: (number | null)[];
                  volume?: (number | null)[];
                },
              ];
              adjclose?: [{ adjclose?: (number | null)[] }];
            };
            events?: { splits?: Record<string, YahooSplit> };
            meta?: { exchangeTimezoneName?: string };
          },
        ]
      | null;
  };
};

/**
 * 거래소 로컬 날짜를 YYYY-MM-DD 문자열로 만든다.
 * new Date()의 로컬 타임존 변환에 의존하지 않기 위해 Intl로 거래소 TZ를 명시한다.
 */
function toExchangeDate(epochSeconds: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(epochSeconds * 1000)); // en-CA → YYYY-MM-DD
}

/**
 * Yahoo 비공식 chart 엔드포인트 어댑터.
 *
 * 조정(adjustment) 처리:
 *  1) 배당 조정 — adjclose/close 비율을 OHLC 전체에 곱한다. 거래량은 배당과 무관하므로 그대로.
 *  2) 분할 조정 — Yahoo는 보통 이미 분할 조정된 값을 주지만 보장은 없다.
 *     splits 이벤트를 받아 분할 전후 종가 점프를 실측해서, 조정이 안 되어 있을 때만 직접 적용한다.
 *     (분할 조정 없이 거래량을 비교하면 액면분할일에 거래량이 인위적으로 튀어 결과가 전부 오염된다.)
 */
export class YahooProvider implements DataProvider {
  readonly name = "yahoo";

  async getDailyBars(ticker: string, years: number): Promise<Bar[]> {
    const now = Math.floor(Date.now() / 1000);
    const period1 = now - Math.ceil(years * 366 * 24 * 60 * 60);
    const url =
      `${BASE}/${encodeURIComponent(ticker)}` +
      `?period1=${period1}&period2=${now}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          // 브라우저 UA가 없으면 Yahoo가 종종 거절한다.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "application/json",
        },
        cache: "no-store",
      });
    } catch (e) {
      throw new DataProviderError(
        `시세 서버에 연결하지 못했습니다: ${(e as Error).message}`,
        502,
      );
    }

    if (res.status === 404) {
      throw new DataProviderError(`'${ticker}' 티커를 찾을 수 없습니다.`, 404);
    }
    if (!res.ok) {
      throw new DataProviderError(
        `시세 서버 오류 (HTTP ${res.status}).`,
        res.status === 429 ? 429 : 502,
      );
    }

    const json = (await res.json()) as YahooChart;
    if (json.chart.error) {
      const code = json.chart.error.code;
      throw new DataProviderError(
        `'${ticker}' 조회 실패: ${json.chart.error.description}`,
        code === "Not Found" ? 404 : 502,
      );
    }

    const result = json.chart.result?.[0];
    if (!result?.timestamp?.length) {
      throw new DataProviderError(`'${ticker}'의 일봉 데이터가 없습니다.`, 404);
    }

    const tz = result.meta?.exchangeTimezoneName || "America/New_York";
    const q = result.indicators.quote[0];
    const adj = result.indicators.adjclose?.[0]?.adjclose;

    const bars: Bar[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      const close = q.close?.[i];
      const volume = q.volume?.[i];
      // 휴장/결측 봉은 버린다.
      if (
        open == null || high == null || low == null ||
        close == null || volume == null || close <= 0
      ) {
        continue;
      }

      // 1) 배당 조정 계수
      const adjClose = adj?.[i];
      const f = adjClose != null && adjClose > 0 ? adjClose / close : 1;

      bars.push({
        date: toExchangeDate(result.timestamp[i], tz),
        open: open * f,
        high: high * f,
        low: low * f,
        close: close * f,
        volume,
      });
    }

    if (!bars.length) {
      throw new DataProviderError(`'${ticker}'의 유효한 일봉이 없습니다.`, 404);
    }

    // 2) 분할 조정 (필요할 때만)
    return applySplitsIfNeeded(bars, Object.values(result.events?.splits ?? {}), tz);
  }
}

/**
 * 분할이 이미 반영돼 있으면 그대로, 아니면 분할 이전 구간의 가격을 1/r, 거래량을 r배 한다.
 * 판정: 분할일 직전 종가 / 분할일 종가 ≈ r 이면 미조정 상태.
 */
export function applySplitsIfNeeded(
  bars: Bar[],
  splits: YahooSplit[],
  timeZone: string,
): Bar[] {
  if (!splits.length) return bars;

  const out = bars.map((b) => ({ ...b }));
  const indexByDate = new Map(out.map((b, i) => [b.date, i]));

  for (const s of splits) {
    const ratio = s.numerator / s.denominator; // 4:1 → 4
    if (!isFinite(ratio) || ratio <= 0 || ratio === 1) continue;

    const splitDate = toExchangeDate(s.date, timeZone);
    const idx = indexByDate.get(splitDate);
    if (idx == null || idx === 0) continue;

    const before = out[idx - 1].close;
    const after = out[idx].close;
    if (!(before > 0 && after > 0)) continue;

    const observedJump = before / after;
    // 미조정이면 점프가 ratio에 가깝다. 노이즈를 감안해 중간값(√ratio)을 임계로 쓴다.
    const alreadyAdjusted = observedJump < Math.sqrt(ratio);
    if (alreadyAdjusted) continue;

    for (let i = 0; i < idx; i++) {
      out[i].open /= ratio;
      out[i].high /= ratio;
      out[i].low /= ratio;
      out[i].close /= ratio;
      out[i].volume *= ratio;
    }
  }

  return out;
}
