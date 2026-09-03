import { json } from "@/lib/json-response";
import { MAX_YEARS, loadBars } from "@/lib/data";
import { attachFunding } from "@/lib/data/funding";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { generateText, GeminiError, summarizeAttempts } from "@/lib/gemini";
import { enrich } from "@/lib/indicators";
import { analyzeCycle, factsForLlm } from "@/lib/cycle";
import { narrate } from "@/lib/cycle/narrative";
import { BarValidationError, validateBars } from "@/lib/validate-bars";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 20년치 일봉 + 소스 폴백까지 감당할 여유.
export const maxDuration = 60;

/** 사이클 하나가 최소 몇 개는 나오려면 이만큼은 필요하다. */
const MIN_BARS = 300;

const SYSTEM = `너는 한국 주식·코인 차트 비서다.
주어진 FACTS의 숫자와 날짜만 사용한다. 없는 값을 지어내지 마라.
5~8문장 한국어. 다음을 반드시 포함한다:
- 과거 상승장 전환이 몇 번이었고 언제였는지
- 매수 근거 여섯 관문을 다 통과한 A등급 신호가 있는지, 있다면 무엇이고 지금 켜져 있는지
  (하나도 없으면 "근거가 데이터에 없다"고 분명히 말한다)
- 그 신호가 바닥보다 빨랐는지 늦었는지
- 지금 무엇이 켜져 있고 과거 상승장 시작 때와 비교해 어느 정도인지
표본이 적다는 사실을 마지막에 한 문장으로 덧붙인다. 매수·매도를 권하지 마라.`;

/**
 * AI 문장 만들기. 실패해도 리포트는 그대로 나가지만, **왜** 실패했는지는 반드시 남긴다.
 *
 * 예전에는 실패를 전부 null로 삼켰다. 그래서 "주식은 되는데 코인만 AI가 안 뜬다" 같은
 * 제보가 와도 화면에도 서버 로그에도 단서가 하나도 없었다. 사유를 사람 말로 돌려주고
 * 같은 문장을 console에도 찍는다 (Vercel 런타임 로그에서 그대로 읽힌다).
 */
type PolishResult = { text: string; model: string } | { error: string };

// 서버 계산(5,040봉 · 지표 31개 채점)은 0.5초면 끝난다. 60초 함수 한도에서 시세 로딩
// 몇 초를 빼도 20초 이상이 남으므로, 느린 모델을 기다려 주는 쪽이 이득이다 —
// 실패하면 어차피 서버 요약문으로 떨어질 뿐 화면이 비지는 않는다.
const AI_DEADLINE_MS = 22_000;

async function polish(facts: string, question: string): Promise<PolishResult> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return { error: "서버에 GEMINI_API_KEY가 없습니다." };
  try {
    const { text, model } = await generateText({
      apiKey,
      system: SYSTEM,
      prompt: `사용자: ${question}\n\nFACTS:\n${facts}\n\n이 FACTS만 가지고 답해라.`,
      json: false,
      maxOutputTokens: 700,
      deadlineMs: AI_DEADLINE_MS,
    });
    const trimmed = text.trim();
    // JSON을 그대로 뱉거나 너무 짧으면 템플릿 문장이 낫다.
    if (trimmed.startsWith("{") || trimmed.startsWith("```") || trimmed.length < 60) {
      const why = `${model}이 문장 대신 ${trimmed.length}자짜리 조각을 돌려줬습니다.`;
      console.warn(`[cycle] AI 응답이 문장이 아님 · facts ${facts.length}자 · ${why}`);
      return { error: why };
    }
    return { text: trimmed, model };
  } catch (e) {
    if (e instanceof GeminiError) {
      const detail = summarizeAttempts(e.attempts);
      console.warn(`[cycle] Gemini 실패 · facts ${facts.length}자 · ${e.message} · ${detail}`);
      return { error: `${e.message} (${detail})` };
    }
    const msg = (e as Error).message;
    console.warn(`[cycle] Gemini 예외 · facts ${facts.length}자 · ${msg}`);
    return { error: `AI 호출 중 오류: ${msg}` };
  }
}

/** 큰 값은 소수점을 줄인다. 67234.5678 → 67234.6, 0.00012345 → 0.00012345 */
function round(v: number): number {
  const abs = Math.abs(v);
  if (abs >= 1000) return Number(v.toFixed(1));
  if (abs >= 1) return Number(v.toFixed(3));
  return Number(v.toFixed(8));
}

function clampPct(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(90, Math.max(5, Math.round(n)));
}

export async function POST(req: Request) {
  let body: {
    ticker?: unknown;
    bars?: unknown;
    years?: unknown;
    bearPct?: unknown;
    bullPct?: unknown;
    question?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const ticker = normalizeTicker(typeof body.ticker === "string" ? body.ticker : "");
  if (!ticker) return json({ error: "티커를 입력해 주세요." }, { status: 400 });
  if (!isValidTicker(ticker)) {
    return json({ error: `'${ticker}'는 올바른 티커 형식이 아닙니다.` }, { status: 400 });
  }

  const years = Math.min(MAX_YEARS, Math.max(3, Math.round(Number(body.years) || MAX_YEARS)));

  // 서버가 시세 소스에 막혔을 때 브라우저가 받아온 일봉을 실어 보낼 수 있다.
  // 형식 검증은 여기서 전부 하고, 계산은 평소처럼 서버 코드가 한다.
  let clientBars: Awaited<ReturnType<typeof loadBars>> | null = null;
  if (body.bars !== undefined) {
    try {
      clientBars = validateBars(body.bars);
    } catch (e) {
      const msg = e instanceof BarValidationError ? e.message : "알 수 없는 오류";
      return json({ error: `일봉 데이터가 올바르지 않습니다: ${msg}` }, { status: 400 });
    }
  }

  try {
    const raw = clientBars ?? (await loadBars(ticker, { years }));
    const bars = await attachFunding(ticker, raw);
    if (bars.length < MIN_BARS) {
      return json(
        {
          error: `'${ticker}'의 일봉이 ${bars.length}개뿐입니다. 사이클 분석은 최소 ${MIN_BARS}일(약 1년 반)이 필요합니다.`,
        },
        { status: 422 },
      );
    }

    const enriched = enrich(bars);
    const report = analyzeCycle(ticker, enriched, {
      thresholds: {
        ...(body.bearPct !== undefined ? { bearPct: clampPct(body.bearPct, 20) } : {}),
        ...(body.bullPct !== undefined ? { bullPct: clampPct(body.bullPct, 25) } : {}),
      },
    });

    const fallbackText = narrate(report);
    const question =
      typeof body.question === "string" && body.question.trim()
        ? body.question.trim().slice(0, 300)
        : `${ticker}는 과거 상승장이 올 때 어떤 지표들이 공통으로 신호를 줬어?`;
    const polished = await polish(factsForLlm(report), question);
    const ok = "text" in polished ? polished : null;
    const reply = ok?.text ?? fallbackText;
    // 어느 모델이 답했는지 화면에 그대로 보여준다. 별칭이 어디로 붙는지는 그때그때 다르다.
    const model = ok?.model ?? null;
    // 실패했으면 그 사유도 화면까지 들고 간다. 숨기면 사용자는 고장인지 정상인지 모른다.
    const aiError = "error" in polished ? polished.error : null;

    // 차트용 시계열. 캔들과 지표 오버레이를 브라우저에서 그리려면 OHLCV가 다 필요하다.
    // 20년치면 5,000봉이라 자릿수를 줄여 payload를 절반으로 만든다
    // (지표 계산에 쓰기엔 충분한 정밀도다).
    const series = enriched.map((b) => ({
      date: b.date,
      open: round(b.open),
      high: round(b.high),
      low: round(b.low),
      close: round(b.close),
      volume: Math.round(b.volume),
    }));

    return json({ report, series, reply, fallbackText, model, aiError });
  } catch (e) {
    if (e instanceof DataProviderError) return json({ error: e.message }, { status: e.status });
    return json({ error: `분석 중 오류가 발생했습니다: ${(e as Error).message}` }, { status: 500 });
  }
}
