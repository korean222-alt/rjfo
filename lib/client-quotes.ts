import type { Bar } from "@/types";

/**
 * 브라우저에서 직접 시세를 받아오는 폴백 경로.
 *
 * 왜 필요한가:
 *  Yahoo는 클라우드/데이터센터 IP(= Vercel 람다)를 자주 429로 막는다. 반면
 *  사용자 폰/PC의 IP는 평범한 가정용·통신사 IP라 막히지 않는다. 서버가 막혔을 때
 *  브라우저가 대신 받아서 서버로 넘겨주면 그대로 분석할 수 있다.
 *
 *  받아온 일봉은 /api/analyze에 실어 보내고, 계산은 여전히 서버 코드가 한다.
 *  (서버는 validate-bars.ts로 형식을 전부 검증한 뒤에만 쓴다.)
 *
 * CORS 주의: 커스텀 헤더를 붙이면 preflight가 생기고 Yahoo는 그걸 허용하지 않는다.
 * 그래서 헤더 없이 단순 GET으로만 부른다.
 */

const HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];

const YEARS = 5;

type YahooChart = {
  chart?: {
    error?: { code?: string; description?: string } | null;
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
      };
      meta?: { exchangeTimezoneName?: string };
    }>;
  };
};

export class ClientQuoteError extends Error {}

/** epoch초 → 거래소 로컬 YYYY-MM-DD. */
function toExchangeDate(epochSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

function toBars(json: YahooChart): Bar[] {
  const result = json.chart?.result?.[0];
  const q = result?.indicators?.quote?.[0];
  if (!result?.timestamp?.length || !q) return [];

  const tz = result.meta?.exchangeTimezoneName || "America/New_York";
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const seen = new Set<string>();
  const bars: Bar[] = [];

  for (let i = 0; i < result.timestamp.length; i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    const volume = q.volume?.[i];
    if (
      open == null || high == null || low == null ||
      close == null || volume == null || close <= 0
    ) {
      continue;
    }

    const date = toExchangeDate(result.timestamp[i], tz);
    if (seen.has(date)) continue; // 같은 날짜가 두 번 오면(장중 봉) 첫 것만
    seen.add(date);

    // 배당 조정 계수 (거래량은 배당과 무관하므로 그대로)
    const adjClose = adj?.[i];
    const f = adjClose != null && adjClose > 0 ? adjClose / close : 1;

    bars.push({
      date,
      open: open * f,
      high: high * f,
      low: low * f,
      close: close * f,
      volume,
    });
  }

  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return bars;
}

/**
 * 브라우저에서 Yahoo 일봉을 받아온다. 실패하면 ClientQuoteError.
 * 서버 폴백이 전부 실패했을 때만 호출한다.
 */
export async function fetchBarsInBrowser(ticker: string): Promise<Bar[]> {
  const now = Math.floor(Date.now() / 1000);
  const period1 = now - Math.ceil(YEARS * 366 * 24 * 60 * 60);
  const query =
    `?period1=${period1}&period2=${now}&interval=1d` +
    `&events=div%2Csplit&includeAdjustedClose=true`;

  let lastDetail = "";

  for (const host of HOSTS) {
    try {
      // 헤더를 붙이지 않아야 CORS preflight가 생기지 않는다.
      const res = await fetch(
        `${host}/v8/finance/chart/${encodeURIComponent(ticker)}${query}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) {
        lastDetail = `HTTP ${res.status}`;
        continue;
      }
      const json = (await res.json()) as YahooChart;
      if (json.chart?.error) {
        lastDetail = json.chart.error.description || json.chart.error.code || "조회 실패";
        continue;
      }
      const bars = toBars(json);
      if (bars.length >= 60) return bars;
      lastDetail = `일봉 ${bars.length}개뿐`;
    } catch (e) {
      // CORS 차단도 여기로 떨어진다 (TypeError: Failed to fetch).
      lastDetail = (e as Error).message;
    }
  }

  throw new ClientQuoteError(lastDetail || "브라우저에서도 시세를 받지 못했습니다.");
}
