import { fetchBarsInBrowser } from "./client-quotes";
import { loadClientBars, saveClientBars, type AnalysisPayload } from "./session";
import type { FilterSpec } from "@/types";

/**
 * 분석 요청 한 번을 끝까지 책임지는 클라이언트 헬퍼.
 *
 *  1) 평소대로 서버에 맡긴다 (서버가 시세를 받아 계산).
 *  2) 서버가 시세 소스에 막히면(429 등) 브라우저가 직접 시세를 받아
 *     같은 라우트에 실어 보낸다. 사용자 IP는 데이터센터 IP와 달리 막히지 않는다.
 *  3) 브라우저에서도 실패하면 서버가 준 원래 에러를 그대로 보여준다.
 */

/** 브라우저 폴백을 시도할 가치가 있는 상태 코드 (= 서버 쪽 시세 소스 문제). */
function isQuoteSourceFailure(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

export type AnalyzeOptions = {
  cluster?: boolean;
  /** 브라우저에서 직접 받아오는 단계에 들어갈 때 알려준다 (버튼 문구 갱신용). */
  onFallback?: () => void;
};

async function postAnalyze(body: Record<string, unknown>) {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as AnalysisPayload & { error?: string };
  return { res, payload };
}

export async function runAnalyze(
  ticker: string,
  spec: FilterSpec,
  opts: AnalyzeOptions = {},
): Promise<AnalysisPayload> {
  const base: Record<string, unknown> = { ticker, spec };
  if (opts.cluster !== undefined) base.cluster = opts.cluster;

  // 이미 브라우저로 받아둔 일봉이 있으면 곧바로 그걸 쓴다 (서버를 또 막히게 하지 않는다).
  const cached = loadClientBars(ticker);
  if (cached) {
    const { res, payload } = await postAnalyze({ ...base, bars: cached });
    if (res.ok) return payload;
    // 캐시가 상했으면 아래 정상 경로로 다시 간다.
  }

  const first = await postAnalyze(base);
  if (first.res.ok) return first.payload;

  const serverError = first.payload.error ?? "분석에 실패했습니다.";
  if (!isQuoteSourceFailure(first.res.status)) throw new Error(serverError);

  opts.onFallback?.();

  let bars;
  try {
    bars = await fetchBarsInBrowser(ticker);
  } catch {
    // 브라우저도 못 받으면 서버 에러가 더 정확한 설명이다.
    throw new Error(serverError);
  }

  const second = await postAnalyze({ ...base, bars });
  if (!second.res.ok) throw new Error(second.payload.error ?? serverError);

  saveClientBars(ticker, bars);
  return second.payload;
}
