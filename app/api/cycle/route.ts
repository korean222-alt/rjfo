import { json } from "@/lib/json-response";
import { MAX_YEARS, loadBars } from "@/lib/data";
import { attachFunding } from "@/lib/data/funding";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { generateText, GeminiError } from "@/lib/gemini";
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
- 그 전환을 공통으로 가리킨 지표가 무엇인지
- 그 지표가 바닥보다 빨랐는지 늦었는지
- 지금 무엇이 켜져 있고 과거와 비교해 어느 정도인지
표본이 적다는 사실을 마지막에 한 문장으로 덧붙인다. 매수·매도를 권하지 마라.`;

async function polish(facts: string, question: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  try {
    const { text } = await generateText({
      apiKey,
      system: SYSTEM,
      prompt: `사용자: ${question}\n\nFACTS:\n${facts}\n\n이 FACTS만 가지고 답해라.`,
      json: false,
      maxOutputTokens: 700,
      deadlineMs: 9_000,
    });
    const trimmed = text.trim();
    // JSON을 그대로 뱉거나 너무 짧으면 템플릿 문장이 낫다.
    if (trimmed.startsWith("{") || trimmed.startsWith("```") || trimmed.length < 60) return null;
    return trimmed;
  } catch (e) {
    if (e instanceof GeminiError) return null;
    return null;
  }
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
    const reply = (await polish(factsForLlm(report), question)) ?? fallbackText;

    // 차트용 시계열. 20년치라 OHLC 전부 보내면 payload가 커진다. 종가만 보낸다.
    const series = enriched.map((b) => ({
      date: b.date,
      close: Number(b.close.toFixed(4)),
    }));

    return json({ report, series, reply, fallbackText });
  } catch (e) {
    if (e instanceof DataProviderError) return json({ error: e.message }, { status: e.status });
    return json({ error: `분석 중 오류가 발생했습니다: ${(e as Error).message}` }, { status: 500 });
  }
}
