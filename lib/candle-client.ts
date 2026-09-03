import { fetchBarsInBrowser } from "./client-quotes";
import { MAX_YEARS } from "./data";
import type { Bar } from "@/types";
import type { CandleReport } from "@/lib/candle";

/**
 * 캔들 분석 요청 한 번을 끝까지 책임지는 클라이언트 헬퍼.
 * 구조는 lib/cycle-client.ts 와 같다: 서버가 시세에 막히면 브라우저가 직접 받아 넘긴다.
 *
 * 기간도 사이클 쪽과 같이 최대한 길게 받는다. 캔들 패턴은 한 번 뜰 때마다 표본 하나라,
 * 20년치를 받아야 잘 안 나오는 패턴(샛별형 등)이 채점 가능한 횟수에 겨우 닿는다.
 */

export type CandlePayload = {
  report: CandleReport;
  series: Bar[];
  reply: string;
  fallbackText: string;
  /** 요약을 만든 Gemini 모델. 키가 없거나 실패해서 템플릿 문장을 쓰면 null. */
  model?: string | null;
  /** AI 문장을 못 만든 이유. 성공했으면 null. 숨기면 고장인지 정상인지 구분이 안 된다. */
  aiError?: string | null;
};

export type CandleRequest = {
  ticker: string;
  horizon?: number;
  question?: string;
};

export type CandleAnswer = { answer: string; model: string | null };

/** 이미 받아둔 리포트에 대한 후속 질문. 시세도 채점도 다시 하지 않는다. */
export async function askCandle(question: string, facts: string): Promise<CandleAnswer> {
  const res = await fetch("/api/candle/ask", {
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

async function readJson(res: Response): Promise<Partial<CandlePayload> & { error?: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Partial<CandlePayload> & { error?: string };
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
  const res = await fetch("/api/candle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, payload: await readJson(res) };
}

function complete(p: Partial<CandlePayload>): p is CandlePayload {
  return Boolean(p.report && p.series && p.reply);
}

export async function runCandle(
  req: CandleRequest,
  onFallback?: () => void,
): Promise<CandlePayload> {
  const base: Record<string, unknown> = { ticker: req.ticker, years: MAX_YEARS };
  if (req.horizon !== undefined) base.horizon = req.horizon;
  if (req.question) base.question = req.question;

  // 채점 구간만 바꾸는 재요청이 잦다. 같은 티커면 받아둔 일봉을 그대로 다시 쓴다.
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
