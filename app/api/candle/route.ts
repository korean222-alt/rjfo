import { json } from "@/lib/json-response";
import { MAX_YEARS, loadBars } from "@/lib/data";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { enrich } from "@/lib/indicators";
import { analyzeCandles, CANDLE_HORIZONS, type CandleHorizon } from "@/lib/candle";
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
    // 서버가 만든 요약문을 그대로 내보낸다. AI 문장은 화면이 뜬 뒤에 /ask 로 따로 받는다 —
    // 여기서 기다리면 모델이 굼뜬 날 리포트 전체가 그만큼 늦게 뜬다(실제로 20초씩 걸렸다).
    const reply = fallbackText;

    // 차트용 시계열. 캔들을 브라우저에서 그리려면 OHLCV가 다 필요하다.
    const series = enriched.map((b) => ({
      date: b.date,
      open: round(b.open),
      high: round(b.high),
      low: round(b.low),
      close: round(b.close),
      volume: Math.round(b.volume),
    }));

    return json({ report, series, reply, fallbackText, model: null, aiError: null });
  } catch (e) {
    if (e instanceof DataProviderError) return json({ error: e.message }, { status: e.status });
    return json({ error: `분석 중 오류가 발생했습니다: ${(e as Error).message}` }, { status: 500 });
  }
}
