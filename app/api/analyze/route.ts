import { json } from "@/lib/json-response";
import { loadBars } from "@/lib/data";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { enrich } from "@/lib/indicators";
import { BarValidationError, validateBars } from "@/lib/validate-bars";
import { analyze } from "@/lib/stats";
import { validateSpec } from "@/lib/validate-spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 시세 소스 폴백(Yahoo 재시도 → Stooq)까지 감당할 여유. 기본 10초로는 모자란다.
export const maxDuration = 30;

export async function POST(req: Request) {
  let body: { ticker?: unknown; spec?: unknown; cluster?: unknown; bars?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const ticker = normalizeTicker(typeof body.ticker === "string" ? body.ticker : "");
  if (!ticker) {
    return json({ error: "티커를 입력해 주세요." }, { status: 400 });
  }
  if (!isValidTicker(ticker)) {
    return json({ error: `'${ticker}'는 올바른 티커 형식이 아닙니다.` }, { status: 400 });
  }

  let spec;
  try {
    spec = validateSpec(body.spec);
  } catch (e) {
    return json({ error: `조건이 올바르지 않습니다: ${(e as Error).message}` }, { status: 400 });
  }

  // 서버가 시세 소스에 막혔을 때, 브라우저가 직접 받아온 일봉을 실어 보낼 수 있다.
  // 형식은 여기서 전부 검증하고, 계산은 평소처럼 서버 코드가 한다.
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
    const bars = clientBars ?? (await loadBars(ticker));
    if (bars.length < 60) {
      return json(
        { error: `'${ticker}'의 데이터가 ${bars.length}일치뿐이라 분석할 수 없습니다.` },
        { status: 422 },
      );
    }
    const enriched = enrich(bars);
    const result = analyze(ticker, enriched, spec, { cluster: body.cluster !== false });

    // 차트용 시계열 (일봉이 많아 payload가 커지므로 필요한 OHLCV 필드만)
    const series = enriched.map((b) => ({
      date: b.date,
      open: Number(b.open.toFixed(4)),
      high: Number(b.high.toFixed(4)),
      low: Number(b.low.toFixed(4)),
      close: Number(b.close.toFixed(4)),
      volume: b.volume,
    }));

    return json({ result, series });
  } catch (e) {
    if (e instanceof DataProviderError) {
      return json({ error: e.message }, { status: e.status });
    }
    return json(
      { error: `분석 중 오류가 발생했습니다: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
