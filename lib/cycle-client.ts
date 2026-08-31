import { fetchBarsInBrowser } from "./client-quotes";
import { MAX_YEARS } from "./data";
import type { Bar } from "@/types";
import type { CycleReport } from "@/lib/cycle";

/**
 * 사이클 분석 요청 한 번을 끝까지 책임지는 클라이언트 헬퍼.
 * 구조는 lib/analyze-client.ts 와 같다: 서버가 시세에 막히면 브라우저가 직접 받아 넘긴다.
 *
 * 다른 점은 기간이다. 상승장 전환은 5년에 한두 번뿐이라 최대한 길게 받아야 한다.
 * 20년치 일봉은 sessionStorage에 넣기엔 커서 페이지 수명 동안 메모리에만 들고 있는다.
 */

export type CyclePayload = {
  report: CycleReport;
  /** 캔들 + 지표 오버레이를 브라우저에서 그리기 위한 OHLCV. */
  series: Bar[];
  reply: string;
  fallbackText: string;
  /** 요약을 만든 Gemini 모델. 키가 없거나 실패해서 템플릿 문장을 쓰면 null. */
  model?: string | null;
};

export type CycleRequest = {
  ticker: string;
  bearPct?: number;
  bullPct?: number;
  question?: string;
};

export type CycleAnswer = { answer: string; model: string | null };

/**
 * 이미 받아둔 리포트에 대해 후속 질문.
 *
 * 시세를 다시 받지도, 지표를 다시 채점하지도 않는다. 화면이 들고 있는 FACTS만
 * 서버로 보내 Gemini에게 질문을 시킨다 (지표 재검색이 아니라 진짜 질의응답).
 */
export async function askCycle(question: string, facts: string): Promise<CycleAnswer> {
  const res = await fetch("/api/cycle/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, facts }),
  });
  const text = await res.text();
  let body: { answer?: string; model?: string; error?: string } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`AI 서버 오류 (HTTP ${res.status}).`);
  }
  if (!res.ok || !body.answer) throw new Error(body.error ?? "답변을 받지 못했습니다.");
  return { answer: body.answer, model: body.model ?? null };
}

const longBars = new Map<string, Bar[]>();

function isQuoteSourceFailure(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

async function readJson(res: Response): Promise<Partial<CyclePayload> & { error?: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Partial<CyclePayload> & { error?: string };
  } catch {
    return {
      error:
        res.status === 504 || res.status === 408
          ? "서버 응답이 너무 느립니다. 잠시 후 다시 시도해 주세요."
          : `분석 서버 오류 (HTTP ${res.status}).`,
    };
  }
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/cycle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, payload: await readJson(res) };
}

function complete(p: Partial<CyclePayload>): p is CyclePayload {
  return Boolean(p.report && p.series && p.reply);
}

export async function runCycle(
  req: CycleRequest,
  onFallback?: () => void,
): Promise<CyclePayload> {
  const base: Record<string, unknown> = { ticker: req.ticker, years: MAX_YEARS };
  if (req.bearPct !== undefined) base.bearPct = req.bearPct;
  if (req.bullPct !== undefined) base.bullPct = req.bullPct;
  if (req.question) base.question = req.question;

  const cached = longBars.get(req.ticker);
  if (cached) {
    const { res, payload } = await post({ ...base, bars: cached });
    if (res.ok && complete(payload)) return payload;
    longBars.delete(req.ticker); // 캐시가 상했으면 아래 정상 경로로
  }

  const first = await post(base);
  if (first.res.ok && complete(first.payload)) return first.payload;

  const serverError = first.payload.error ?? "분석에 실패했습니다.";
  if (!isQuoteSourceFailure(first.res.status)) throw new Error(serverError);

  onFallback?.();

  let bars: Bar[];
  try {
    bars = await fetchBarsInBrowser(req.ticker, MAX_YEARS);
  } catch {
    // 브라우저도 못 받으면 서버 에러가 더 정확한 설명이다.
    throw new Error(serverError);
  }

  const second = await post({ ...base, bars });
  if (!second.res.ok || !complete(second.payload)) {
    throw new Error(second.payload.error ?? serverError);
  }
  longBars.set(req.ticker, bars);
  return second.payload;
}
