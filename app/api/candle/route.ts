import { json } from "@/lib/json-response";
import { MAX_YEARS, loadBars } from "@/lib/data";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { generateText, GeminiError } from "@/lib/gemini";
import { enrich } from "@/lib/indicators";
import { analyzeCandles, factsForLlm, CANDLE_HORIZONS, type CandleHorizon } from "@/lib/candle";
import { narrate } from "@/lib/candle/narrative";
import { BarValidationError, validateBars } from "@/lib/validate-bars";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 20년치 일봉 + 소스 폴백까지 감당할 여유.
export const maxDuration = 60;

/**
 * 패턴 하나가 스무 번은 나와야 채점이 되고, 앞뒤 기간을 나누려면 그 두 배가 필요하다.
 * 400봉(약 1년 반)이 그 최소선이다.
 */
const MIN_BARS = 400;

const SYSTEM = `너는 한국 주식·코인 차트 비서다.
주어진 FACTS의 숫자와 날짜만 사용한다. 없는 값을 지어내지 마라.
5~8문장 한국어. 다음을 반드시 포함한다:
- 이 종목의 기저율(아무 날이나 샀을 때의 상승 확률·평균 수익)을 먼저 말한다
- 여섯 관문을 다 통과한 A등급 캔들 패턴이 있는지, 있다면 무엇이고 적중률이 기저보다 몇 %p 높은지
  (하나도 없으면 "근거가 데이터에 없다"고 분명히 말한다)
- 마지막 봉이 어떤 모양이고 지금 무슨 패턴이 떠 있는지
- 그 패턴의 과거 성적이 무엇이었는지 (평균 수익과 적중률을 기저와 나란히)
캔들 패턴의 효과는 원래 작다는 사실과, 이건 예언이 아니라 과거 같은 모양 뒤의 평균이라는 사실을
마지막에 한 문장으로 덧붙인다. 매수·매도를 권하지 마라.`;

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

/** 큰 값은 소수점을 줄인다. 67234.5678 → 67234.6, 0.00012345 → 0.00012345 */
function round(v: number): number {
  const abs = Math.abs(v);
  if (abs >= 1000) return Number(v.toFixed(1));
  if (abs >= 1) return Number(v.toFixed(3));
  return Number(v.toFixed(8));
}

function clampHorizon(raw: unknown): CandleHorizon | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return (CANDLE_HORIZONS as readonly number[]).includes(n) ? (n as CandleHorizon) : undefined;
}

export async function POST(req: Request) {
  let body: {
    ticker?: unknown;
    bars?: unknown;
    years?: unknown;
    horizon?: unknown;
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
    const bars = clientBars ?? (await loadBars(ticker, { years }));
    if (bars.length < MIN_BARS) {
      return json(
        {
          error: `'${ticker}'의 일봉이 ${bars.length}개뿐입니다. 캔들 패턴 채점은 최소 ${MIN_BARS}일(약 1년 반)이 필요합니다.`,
        },
        { status: 422 },
      );
    }

    const enriched = enrich(bars);
    const report = analyzeCandles(ticker, enriched, { horizon: clampHorizon(body.horizon) });

    const fallbackText = narrate(report);
    const question =
      typeof body.question === "string" && body.question.trim()
        ? body.question.trim().slice(0, 300)
        : `${ticker}는 어떤 캔들이 나오면 오르는 편이야? 지금 마지막 봉은 어때?`;
    const polished = await polish(factsForLlm(report), question);
    const reply = polished?.text ?? fallbackText;
    const model = polished?.model ?? null;

    // 차트용 시계열. 캔들을 브라우저에서 그리려면 OHLCV가 다 필요하다.
    const series = enriched.map((b) => ({
      date: b.date,
      open: round(b.open),
      high: round(b.high),
      low: round(b.low),
      close: round(b.close),
      volume: Math.round(b.volume),
    }));

    return json({ report, series, reply, fallbackText, model });
  } catch (e) {
    if (e instanceof DataProviderError) return json({ error: e.message }, { status: e.status });
    return json({ error: `분석 중 오류가 발생했습니다: ${(e as Error).message}` }, { status: 500 });
  }
}
