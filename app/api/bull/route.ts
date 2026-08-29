import { json } from "@/lib/json-response";
import { loadBars } from "@/lib/data";
import { attachFunding } from "@/lib/data/funding";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { enrich } from "@/lib/indicators";
import { BarValidationError, validateBars } from "@/lib/validate-bars";
import { bullReport } from "@/lib/bull";
import { aggregateBars, toTimeframe, TIMEFRAME_LABEL } from "@/lib/timeframe";
import { toTradingViewSymbol } from "@/lib/tradingview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 봉을 만들려면 최소한 이만큼의 일봉은 있어야 한다. */
const MIN_DAILY_BARS = 40;

export async function POST(req: Request) {
  let body: { ticker?: unknown; timeframe?: unknown; bars?: unknown };
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

  const timeframe = toTimeframe(body.timeframe);

  // /api/analyze와 같은 폴백: 서버가 시세 소스에 막히면 브라우저가 받아온 일봉을 실어 보낸다.
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
    const raw = clientBars ?? (await loadBars(ticker));
    const daily = await attachFunding(ticker, raw);
    if (daily.length < MIN_DAILY_BARS) {
      return json(
        { error: `'${ticker}'의 데이터가 ${daily.length}일치뿐이라 지표를 만들 수 없습니다.` },
        { status: 422 },
      );
    }

    const periods = aggregateBars(daily, timeframe);
    if (periods.length < 3) {
      return json(
        {
          error:
            `'${ticker}'는 ${TIMEFRAME_LABEL[timeframe]}이 ${periods.length}개뿐이라 ` +
            "지표를 만들 수 없습니다.",
        },
        { status: 422 },
      );
    }

    const report = bullReport(ticker, timeframe, enrich(periods), periods);

    // 참고용 시계열 (최근 240봉이면 화면에 충분하다).
    const series = periods.slice(-240).map((b) => ({
      date: b.date,
      open: Number(b.open.toFixed(4)),
      high: Number(b.high.toFixed(4)),
      low: Number(b.low.toFixed(4)),
      close: Number(b.close.toFixed(4)),
      volume: b.volume,
    }));

    return json({ report, symbol: toTradingViewSymbol(ticker), series });
  } catch (e) {
    if (e instanceof DataProviderError) return json({ error: e.message }, { status: e.status });
    return json(
      { error: `지표를 만드는 중 오류가 발생했습니다: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
