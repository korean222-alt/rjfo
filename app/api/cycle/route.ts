import { json } from "@/lib/json-response";
import { MAX_YEARS, loadBars } from "@/lib/data";
import { attachFunding } from "@/lib/data/funding";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { generateText, GeminiError } from "@/lib/gemini";
import { enrich } from "@/lib/indicators";
import { analyzeCycle, factsForLlm } from "@/lib/cycle";
import { toChartSeries } from "@/lib/cycle/series";
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

async function polish(
  facts: string,
  question: string,
): Promise<{ text: string; model: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  try {
    const { text, model } = await generateText({
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
    return { text: trimmed, model };
  } catch (e) {
    if (e instanceof GeminiError) return null;
    return null;
  }
}

/**
 * 화면에서 넘어온 임계값. 숫자가 아니면 undefined를 돌려 자산군 기본값
 * (regime.ts의 주식 -20/+40, 코인 -40/+80)을 그대로 쓰게 한다.
 * 예전에는 여기서 20/25를 대신 넣어, 코인인데 조용히 주식 기준으로 채점되곤 했다.
 */
function clampPct(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
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
    const bearPct = clampPct(body.bearPct);
    const bullPct = clampPct(body.bullPct);
    const report = analyzeCycle(ticker, enriched, {
      thresholds: {
        ...(bearPct !== undefined ? { bearPct } : {}),
        ...(bullPct !== undefined ? { bullPct } : {}),
      },
    });

    const fallbackText = narrate(report);
    const question =
      typeof body.question === "string" && body.question.trim()
        ? body.question.trim().slice(0, 300)
        : `${ticker}는 과거 상승장이 올 때 어떤 지표들이 공통으로 신호를 줬어?`;
    const polished = await polish(factsForLlm(report), question);
    const reply = polished?.text ?? fallbackText;
    // 어느 모델이 답했는지 화면에 그대로 보여준다. 별칭이 어디로 붙는지는 그때그때 다르다.
    const model = polished?.model ?? null;

    // 차트용 시계열 (lib/cycle/series.ts). 브라우저가 여기에 같은 enrich()를 다시 돌린다.
    const series = toChartSeries(enriched);

    return json({ report, series, reply, fallbackText, model });
  } catch (e) {
    if (e instanceof DataProviderError) return json({ error: e.message }, { status: e.status });
    return json({ error: `분석 중 오류가 발생했습니다: ${(e as Error).message}` }, { status: 500 });
  }
}
