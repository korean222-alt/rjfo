import { fetchBarsInBrowser } from "./client-quotes";
import { loadClientBars, saveClientBars } from "./session";
import type { BullReport } from "@/lib/bull";
import type { Timeframe } from "@/lib/timeframe";

export type BullSeriesPoint = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type BullPayload = {
  report: BullReport;
  symbol: string;
  series: BullSeriesPoint[];
};

/** 브라우저 폴백을 시도할 가치가 있는 상태 코드 (= 서버 쪽 시세 소스 문제). */
function isQuoteSourceFailure(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/bull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: Partial<BullPayload> & { error?: string };
  try {
    payload = JSON.parse(text) as Partial<BullPayload> & { error?: string };
  } catch {
    payload = {
      error:
        res.status === 504 || res.status === 408
          ? "서버 응답이 너무 느립니다. 잠시 후 다시 시도해 주세요."
          : `지표 서버 오류 (HTTP ${res.status}).`,
    };
  }
  return { res, payload };
}

export type BullOptions = {
  /** 브라우저가 직접 시세를 받아오는 단계에 들어갈 때 알려준다. */
  onFallback?: () => void;
};

/**
 * 상승장 지표 한 번을 끝까지 책임진다. /api/analyze 쪽 runAnalyze와 같은 3단계다.
 *  1) 서버에 맡긴다 → 2) 서버가 시세에 막히면 브라우저가 받아 실어 보낸다 → 3) 그래도 실패면 원래 에러.
 */
export async function runBull(
  ticker: string,
  timeframe: Timeframe,
  opts: BullOptions = {},
): Promise<BullPayload> {
  const base: Record<string, unknown> = { ticker, timeframe };

  // 이미 브라우저로 받아둔 일봉이 있으면 그걸 먼저 쓴다 (서버를 또 막히게 하지 않는다).
  const cached = loadClientBars(ticker);
  if (cached) {
    const { res, payload } = await post({ ...base, bars: cached });
    if (res.ok && payload.report) return payload as BullPayload;
  }

  const first = await post(base);
  if (first.res.ok && first.payload.report) return first.payload as BullPayload;

  const serverError = first.payload.error ?? "지표를 만들지 못했습니다.";
  if (!isQuoteSourceFailure(first.res.status)) throw new Error(serverError);

  opts.onFallback?.();

  let bars;
  try {
    bars = await fetchBarsInBrowser(ticker);
  } catch {
    throw new Error(serverError);
  }

  const second = await post({ ...base, bars });
  if (!second.res.ok || !second.payload.report) {
    throw new Error(second.payload.error ?? serverError);
  }

  saveClientBars(ticker, bars);
  return second.payload as BullPayload;
}
