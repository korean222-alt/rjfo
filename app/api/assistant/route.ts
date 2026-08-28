import { json } from "@/lib/json-response";
import { MAX_YEARS, loadBars } from "@/lib/data";
import { attachFunding } from "@/lib/data/funding";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { parseAssistantIntent } from "@/lib/assistant-intent";
import { generateText, GeminiError } from "@/lib/gemini";
import { enrich } from "@/lib/indicators";
import { analyzeCycle, factsForLlm } from "@/lib/cycle";
import { narrate } from "@/lib/cycle/narrative";
import { scanMaBreakout, scanSurgePrelude, type ChartMarker } from "@/lib/scan";
import { analyzeAtDates } from "@/lib/stats";
import type { AnalysisResult, EnrichedBar, FilterSpec } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 사이클 질문은 20년치 일봉을 받아야 해서 30초로는 모자랄 수 있다.
export const maxDuration = 60;

const SYSTEM = `너는 한국 주식·코인 차트 비서다.
주어진 FACTS의 숫자와 날짜만 사용한다. 없는 값을 만들지 마라.
3~6문장 한국어. 마지막에 다음에 물어볼 문장을 하나 제안한다.`;

function seriesOf(bars: EnrichedBar[]) {
  return bars.map((b) => ({
    date: b.date,
    open: Number(b.open.toFixed(4)),
    high: Number(b.high.toFixed(4)),
    low: Number(b.low.toFixed(4)),
    close: Number(b.close.toFixed(4)),
    volume: b.volume,
    funding: b.funding_pct,
  }));
}

function fmt(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "없음";
  return n.toFixed(digits);
}

function templateSurge(ticker: string, s: ReturnType<typeof scanSurgePrelude>, windowDays: number, lookbackDays: number, minReturnPct: number) {
  const n = s.summary.count ?? 0;
  if (!n) {
    return `${ticker}에서 ${windowDays}일 안에 ${minReturnPct}% 이상 급등한 구간을 찾지 못했습니다. 기간이나 기준을 낮춰 보세요.`;
  }
  const samples = s.events.slice(-3).map((e) => `${e.date} → ${e.endDate} (${e.returnPct.toFixed(1)}%)`).join(", ");
  return [
    `${ticker}에서 ${windowDays}일 안에 ${minReturnPct}% 이상 급등한 구간을 ${n}번 찾았습니다.`,
    `평균 급등폭은 ${fmt(s.summary.avgReturn)}%, 중앙값은 ${fmt(s.summary.medianReturn)}%입니다.`,
    `급등 직전 ${lookbackDays}일 거래량은 평소 대비 평균 ${fmt(s.summary.avgLookbackVolRatio)}배였고, 그 중 2배 이상인 날은 ${fmt(s.summary.lookbackSpikeShare)}%입니다.`,
    s.summary.avgLookbackFundingPct != null ? `같은 구간의 평균 펀딩비는 ${fmt(s.summary.avgLookbackFundingPct, 4)}%입니다.` : "",
    `최근 사례: ${samples}.`,
    `차트에 급등 시작일을 표시했습니다. "표시 끄기"라고 하면 지웁니다.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function templateBreakout(ticker: string, s: ReturnType<typeof scanMaBreakout>, period: number, holdDays: number, direction: "up" | "down") {
  const n = s.summary.count ?? 0;
  const way = direction === "down" ? "하향" : "상향";
  if (!n) return `${ticker}에서 ${period}일선 ${way} 돌파를 찾지 못했습니다.`;
  const samples = s.events.slice(-3).map((e) => `${e.date}${e.forwardPct != null ? ` (${e.forwardPct >= 0 ? "+" : ""}${e.forwardPct.toFixed(1)}%)` : ""}`).join(", ");
  return [
    `${ticker}의 ${period}일선 ${way} 돌파는 ${n}번입니다.`,
    `돌파 후 ${holdDays}일 평균 수익률은 ${fmt(s.summary.avgForward)}%, 중앙값은 ${fmt(s.summary.medianForward)}%, 플러스인 비율은 ${fmt(s.summary.winShare)}%입니다.`,
    `아무 날이나 골랐을 때와 비교하려면 결과 카드의 기준선(base rate)을 보세요.`,
    `최근 돌파: ${samples}.`,
    `차트에 돌파일을 표시했습니다.`,
  ].join(" ");
}

async function polish(facts: string, user: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  try {
    const { text } = await generateText({
      apiKey,
      system: SYSTEM,
      prompt: `사용자: ${user}\n\nFACTS:\n${facts}\n\n이 FACTS만 가지고 답해라.`,
      json: false,
      maxOutputTokens: 512,
      deadlineMs: 8_000,
    });
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("```") || trimmed.length < 40) return null;
    return trimmed;
  } catch (e) {
    if (e instanceof GeminiError) return null;
    return null;
  }
}

export async function POST(req: Request) {
  let body: { ticker?: unknown; message?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "질문을 입력해 주세요." }, { status: 400 });
  if (message.length > 500) return json({ error: "질문이 너무 깁니다." }, { status: 400 });

  const intent = parseAssistantIntent(message);
  if (intent.kind === "mark" || intent.kind === "clear") {
    return json({
      reply:
        intent.kind === "clear"
          ? "차트 표시를 지웠습니다."
          : "직전 분석의 신호를 차트에 다시 표시합니다.",
      action: intent.kind,
      markers: [] as ChartMarker[],
    });
  }

  if (intent.kind === "draw_ma") {
    return json({
      reply: `${intent.period}일선을 차트에 그렸습니다. 분석을 다시 누르지 않아도 바로 보입니다.`,
      action: "draw_ma",
      period: intent.period,
      overlayPeriods: [intent.period],
      markers: [] as ChartMarker[],
    });
  }

  const intentTicker =
    intent.kind === "surge_prelude" || intent.kind === "ma_breakout" || intent.kind === "cycle"
      ? intent.ticker
      : undefined;
  const rawTicker = intentTicker || (typeof body.ticker === "string" ? body.ticker : "");
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) return json({ error: "티커를 먼저 입력해 주세요. 예: BTC, ORCL" }, { status: 400 });
  if (!isValidTicker(ticker)) return json({ error: `'${ticker}'는 올바른 티커가 아닙니다.` }, { status: 400 });

  if (intent.kind === "cycle") {
    // 사이클 분석은 20년치가 필요하다. 아래 공통 로드(5년)로는 사이클이 한두 개밖에 안 잡힌다.
    try {
      const raw = await attachFunding(ticker, await loadBars(ticker, { years: MAX_YEARS }));
      if (raw.length < 300) {
        return json(
          { error: `'${ticker}' 일봉이 ${raw.length}개뿐이라 사이클 분석을 못 합니다.` },
          { status: 422 },
        );
      }
      const report = analyzeCycle(ticker, enrich(raw));
      const reply = (await polish(factsForLlm(report), message)) ?? narrate(report);
      return json({ reply, ticker, action: "cycle", markers: [] as ChartMarker[] });
    } catch (e) {
      if (e instanceof DataProviderError) return json({ error: e.message }, { status: e.status });
      return json({ error: `시세를 가져오지 못했습니다: ${(e as Error).message}` }, { status: 502 });
    }
  }

  let bars: EnrichedBar[];
  try {
    const raw = await attachFunding(ticker, await loadBars(ticker));
    if (raw.length < 60) {
      return json({ error: `'${ticker}' 데이터가 ${raw.length}일치뿐이라 분석할 수 없습니다.` }, { status: 422 });
    }
    bars = enrich(raw);
  } catch (e) {
    if (e instanceof DataProviderError) return json({ error: e.message }, { status: e.status });
    return json({ error: `시세를 가져오지 못했습니다: ${(e as Error).message}` }, { status: 502 });
  }

  if (intent.kind === "chat") {
    const last = bars[bars.length - 1];
    const facts = `${ticker} 최근 ${last.date} 종가 ${last.close}, 거래량 배수 ${last.volume_ratio_20d ?? "없음"}, 펀딩 ${last.funding_pct ?? "없음"}`;
    const reply =
      (await polish(facts, message)) ??
      `${ticker} 최근 종가는 ${last.close.toFixed(2)}입니다. 이렇게 물어보세요: "10일만에 10%이상 급등 20일전 거래량 분석해줘" 또는 "200일 이평선 돌파 30일 후 어떻게됐어?"`;
    return json({ reply, ticker, action: "chat", markers: [] as ChartMarker[] });
  }

  let interpretation = "";
  let markers: ChartMarker[] = [];
  let dates: string[] = [];
  let reply = "";
  let facts = "";

  if (intent.kind === "surge_prelude") {
    const scan = scanSurgePrelude(bars, {
      windowDays: intent.windowDays,
      minReturnPct: intent.minReturnPct,
      lookbackDays: intent.lookbackDays,
    });
    interpretation = `${intent.windowDays}일 안에 ${intent.minReturnPct}% 이상 급등하기 전 ${intent.lookbackDays}일 거래량`;
    markers = scan.markers;
    dates = scan.events.map((e) => e.date);
    reply = templateSurge(ticker, scan, intent.windowDays, intent.lookbackDays, intent.minReturnPct);
    facts = JSON.stringify(scan.summary);
  } else {
    const scan = scanMaBreakout(bars, {
      period: intent.period,
      holdDays: intent.holdDays,
      direction: intent.direction,
    });
    interpretation = `${intent.period}일선 ${intent.direction === "down" ? "하향" : "상향"} 돌파 후 ${intent.holdDays}일`;
    markers = scan.markers;
    dates = scan.events.map((e) => e.date);
    reply = templateBreakout(ticker, scan, intent.period, intent.holdDays, intent.direction);
    facts = JSON.stringify(scan.summary);
  }

  const polished = await polish(`${ticker} ${interpretation} ${facts}`, message);
  if (polished) reply = polished;

  const spec: FilterSpec = {
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 0 }],
    logic: "AND",
    interpretation,
    confidence: "low",
    preset: null,
  };
  const result: AnalysisResult = analyzeAtDates(ticker, bars, spec, dates);
  result.lookaheadUsed = intent.kind === "surge_prelude";

  return json({
    reply,
    ticker,
    action: "scan",
    markers,
    result,
    series: seriesOf(bars),
    overlayPeriods: intent.kind === "ma_breakout" ? [intent.period] : [],
  });
}
