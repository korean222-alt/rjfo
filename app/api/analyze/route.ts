import { NextResponse } from "next/server";
import { loadBars } from "@/lib/data";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { enrich } from "@/lib/indicators";
import { analyze } from "@/lib/stats";
import { validateSpec } from "@/lib/validate-spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { ticker?: unknown; spec?: unknown; cluster?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const ticker = normalizeTicker(typeof body.ticker === "string" ? body.ticker : "");
  if (!ticker) {
    return NextResponse.json({ error: "티커를 입력해 주세요." }, { status: 400 });
  }
  if (!isValidTicker(ticker)) {
    return NextResponse.json({ error: `'${ticker}'는 올바른 티커 형식이 아닙니다.` }, { status: 400 });
  }

  let spec;
  try {
    spec = validateSpec(body.spec);
  } catch (e) {
    return NextResponse.json({ error: `조건이 올바르지 않습니다: ${(e as Error).message}` }, { status: 400 });
  }

  try {
    const bars = await loadBars(ticker);
    if (bars.length < 60) {
      return NextResponse.json(
        { error: `'${ticker}'의 데이터가 ${bars.length}일치뿐이라 분석할 수 없습니다.` },
        { status: 422 },
      );
    }
    const enriched = enrich(bars);
    const result = analyze(ticker, enriched, spec, { cluster: body.cluster !== false });

    // 차트용 시계열 (일봉이 많아 payload가 커지므로 필요한 필드만)
    const series = enriched.map((b) => ({
      date: b.date,
      close: Number(b.close.toFixed(4)),
      volume: b.volume,
    }));

    return NextResponse.json({ result, series });
  } catch (e) {
    if (e instanceof DataProviderError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: `분석 중 오류가 발생했습니다: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
