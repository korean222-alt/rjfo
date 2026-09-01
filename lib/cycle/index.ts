/**
 * 상승장 지표 분석의 진입점.
 *
 * 티커 하나를 받아서
 *   1) 과거 상승장 시작점(바닥)을 라벨링하고
 *   2) 지표 배터리를 전부 돌려서
 *   3) 각 지표가 그 바닥들을 얼마나 잡았는지 채점하고
 *   4) 지금 무엇이 켜져 있는지 알려준다.
 *
 * 숫자는 전부 이 파일 아래의 TypeScript가 계산한다. LLM은 결과를 문장으로 옮길 뿐이다.
 */

import type { EnrichedBar } from "@/types";
import {
  DEFAULT_WINDOW,
  HORIZONS,
  baselineStats,
  cycleWindowShare,
  evaluateSignal,
  onCountAt,
  resolveWindow,
  MAX_WINDOW_SHARE,
  type ForwardStat,
  type MatchWindow,
  type SignalEvaluation,
} from "./evaluate";
import { buildCombos, type ComboEvaluation } from "./combos";
import { gradeSignals, type GradedSignal } from "./grade";
import {
  currentRegime,
  findCycles,
  thresholdsFor,
  type Cycle,
  type CycleThresholds,
} from "./regime";
import { buildSignals, type SignalSeries } from "./signals";

export * from "./combos";
export * from "./evaluate";
export * from "./grade";
export * from "./regime";
export * from "./signals";

/** 바닥 며칠 뒤 시점에서 '그때 켜져 있던 지표 수'를 재는지 (거래일). */
const CYCLE_START_OFFSET = 30;

export type CycleStartSnapshot = {
  troughDate: string;
  measuredDate: string;
  on: number;
  total: number;
  /** 미완성이면 확인형 지표가 아직 안 켜져 평균을 구조적으로 끌어내린다. */
  complete: boolean;
  /** 워밍업 중인 지표는 분모에서 빠지므로 시점마다 total이 달라 개수로는 비교가 안 된다. */
  onPct: number;
};

export type CycleReport = {
  ticker: string;
  assetClass: "코인" | "주식";
  thresholds: CycleThresholds;
  window: MatchWindow;
  periodStart: string;
  periodEnd: string;
  totalBars: number;
  years: number;
  cycles: Cycle[];
  regime: ReturnType<typeof currentRegime>;
  baseline: Record<string, ForwardStat>;
  /** 전체 기간 중 '상승장 시작 부근'이 차지하는 비율(%). 지표 lift의 기준선. */
  windowSharePct: number;
  /**
   * 창이 한도(전체의 35%)를 넘어 뒤쪽을 줄였는지, 그리고 원래 요청한 창.
   *
   * 왜 보여주는가: 사이클이 잦은 종목은 창이 전체의 절반을 넘어 '상승장 시작 부근'이라는
   * 라벨이 의미를 잃는다. 줄였다는 사실을 숨기면, 같은 지표가 종목마다 다른 창으로
   * 채점된 걸 모른 채 등급을 비교하게 된다.
   */
  windowShrunk: boolean;
  windowRequested: MatchWindow;
  signals: GradedSignal[];
  /**
   * 지표 두 개를 겹친 매수 규칙. "365일선 위 + 주봉 MACD 골든크로스"처럼.
   * 단일 지표와 같은 다중검정 보정 풀에서 q값을 매긴다.
   */
  combos: (GradedSignal & { members: [string, string] })[];
  /**
   * 과거 상승장 시작을 하나도 빠짐없이 '새로 켜져서' 잡아낸 지표들.
   * 바닥에 그냥 켜져 있던 것(alreadyOn)은 여기 못 들어온다.
   */
  commonKeys: string[];
  now: { date: string; on: number; total: number };
  cycleStarts: CycleStartSnapshot[];
  reliability: "매우 낮음" | "낮음" | "보통";
  warnings: string[];
};

/** 구버전 캐시에는 onPct가 없어서 Math.round(undefined)가 NaN이 된다. */
export function snapshotOnPct(c: { on: number; total: number; onPct?: number }): number {
  if (typeof c.onPct === "number" && Number.isFinite(c.onPct)) return c.onPct;
  return c.total > 0 ? (c.on / c.total) * 100 : 0;
}

/**
 * 평균에 넣을 스냅샷.
 * complete 필드가 없는 구캐시는 측정일이 오늘인 마지막 항목만 미완성으로 본다.
 */
export function completedStarts(starts: CycleStartSnapshot[], nowDate: string): CycleStartSnapshot[] {
  if (!starts.length) return [];
  const versioned = starts.every((c) => typeof c.complete === "boolean");
  if (versioned) return starts.filter((c) => c.complete);
  return starts.filter((c, i) => !(i === starts.length - 1 && c.measuredDate === nowDate));
}

export type AnalyzeCycleOptions = {
  thresholds?: Partial<CycleThresholds>;
  window?: Partial<MatchWindow>;
};

export function analyzeCycle(
  ticker: string,
  bars: EnrichedBar[],
  opts: AnalyzeCycleOptions = {},
): CycleReport {
  const base = thresholdsFor(ticker);
  const thresholds: CycleThresholds = {
    bearPct: opts.thresholds?.bearPct ?? base.bearPct,
    bullPct: opts.thresholds?.bullPct ?? base.bullPct,
  };
  const requestedWindow: MatchWindow = {
    before: opts.window?.before ?? DEFAULT_WINDOW.before,
    after: opts.window?.after ?? DEFAULT_WINDOW.after,
  };

  const cycles = findCycles(bars, thresholds);
  const signals: SignalSeries[] = buildSignals(bars);
  const baseline = baselineStats(bars);

  // 창이 전체 기간의 35%를 넘게 덮으면 뒤쪽을 줄인다. 그래야 우연대비의 천장이
  // 눌리지 않고, 사이클이 잦은 종목과 드문 종목을 같은 자로 재게 된다.
  const resolved = resolveWindow(bars.length, cycles, requestedWindow);
  const window = resolved.window;
  const windowShare = resolved.share;
  const singles = signals
    .map((s) => evaluateSignal(bars, s, cycles, baseline, windowShare, { window }))
    .sort((a, b) => b.score - a.score);

  // 조합은 상위 지표들로만 만든다. 만든 개수는 아래 다중검정 보정 풀에 그대로 들어간다.
  const comboEvals: ComboEvaluation[] = buildCombos(
    bars,
    signals,
    singles,
    cycles,
    baseline,
    windowShare,
    { window },
  );

  // q값은 '한꺼번에 몇 개를 쟀느냐'에 달려 있다. 단일과 조합을 한 풀에 넣고 같이 보정한다.
  const graded = gradeSignals([...singles, ...comboEvals]);
  const evaluated = graded.slice(0, singles.length);
  const combos = graded.slice(singles.length).map((g, i) => ({
    ...g,
    members: comboEvals[i].members,
  }));

  const lastIdx = bars.length - 1;
  const nowCount = onCountAt(signals, lastIdx);

  const cycleStarts: CycleStartSnapshot[] = cycles.map((c) => {
    const targetIdx = c.troughIdx + CYCLE_START_OFFSET;
    // 데이터가 30거래일에 못 미치면 오늘로 잘리므로, 평균에서는 빼야 한다.
    const complete = targetIdx <= lastIdx;
    const idx = Math.min(lastIdx, targetIdx);
    const counted = onCountAt(signals, idx);
    return {
      troughDate: c.troughDate,
      measuredDate: bars[idx].date,
      on: counted.on,
      total: counted.total,
      complete,
      onPct: counted.total > 0 ? (counted.on / counted.total) * 100 : 0,
    };
  });

  const commonKeys = evaluated
    .filter((s) => cycles.length > 0 && s.hitRate === 100)
    .map((s) => s.key);

  const years = bars.length ? tradingYears(bars[0].date, bars[lastIdx].date) : 0;
  const reliability = cycles.length >= 4 ? "보통" : cycles.length >= 3 ? "낮음" : "매우 낮음";

  const warnings: string[] = [];
  if (cycles.length === 0) {
    warnings.push(
      `이 기간에는 기준(고점 대비 -${thresholds.bearPct}% 하락 후 +${thresholds.bullPct}% 반등)을 만족하는 상승장 전환이 없습니다. 기준을 낮추거나 더 긴 데이터가 필요합니다.`,
    );
  } else if (cycles.length < 3) {
    warnings.push(
      `사이클 표본이 ${cycles.length}개뿐입니다. 여기 나오는 적중률은 통계가 아니라 사례 나열에 가깝습니다.`,
    );
  } else {
    warnings.push(
      `사이클 표본 ${cycles.length}개. 이 정도 표본에서는 100% 적중도 우연일 수 있습니다.`,
    );
  }
  warnings.push(
    "적중은 '상승장 시작 부근에서 새로 켜진 것'만 셉니다. 하락장 내내 켜진 채로 바닥을 지나온 지표는 적중이 아니라 '이미 켜짐'으로 따로 표시합니다 — 그렇게 세지 않으면 늘 켜져 있는 지표가 전부 적중률 100%가 됩니다.",
  );

  // 다중검정: 30개를 재면 '우연일 확률 5% 미만'짜리가 그냥 한두 개 나온다.
  // 그 기대 개수를 실제 개수와 나란히 보여줘야 사용자가 속지 않는다.
  const tested = graded.length;
  const rawSignificant = graded.filter((s) => s.chance != null && s.chance < 0.05).length;
  const afterFdr = graded.filter((s) => s.qValue != null && s.qValue < 0.1).length;
  warnings.push(
    `단일 지표 ${evaluated.length}개 + 조합 ${combos.length}개, 모두 ${tested}가지를 한꺼번에 검사했습니다. ` +
      `여러 개를 동시에 시험하면 그중 일부는 우연히 좋아 보입니다(다중검정). 아무 의미 없는 것만 ${tested}가지 늘어놔도 ` +
      `평균 ${(tested * 0.05).toFixed(1)}개는 '우연일 확률 5% 미만'이 됩니다 — 지금 그게 ${rawSignificant}개입니다. ` +
      `그래서 보정한 확률(q값)을 따로 매겼고, 보정 후에도 남는 건 ${afterFdr}개입니다. 등급 판정은 이 q값으로 합니다.`,
  );
  const buyable = graded.filter((s) => s.grade === "A").length;
  warnings.push(
    buyable
      ? `여섯 관문을 다 통과한 신호가 ${buyable}개입니다. 그래도 과거 표본이 사이클 ${cycles.length}번뿐이라는 사실은 변하지 않습니다.`
      : "여섯 관문을 다 통과한 신호는 없습니다. 지금 이 종목에서 '이거 뜨면 사도 된다'고 말할 근거는 데이터에 없습니다.",
  );
  if (cycles.length) {
    warnings.push(
      `전체 기간의 ${(windowShare * 100).toFixed(0)}%가 '상승장 시작 부근'입니다. 자주 켜지는 지표는 그것만으로도 적중률이 높게 나오므로, 적중률보다 '우연대비' 배수를 보세요. ` +
        `이 비율이 곧 우연대비의 천장을 정합니다 — 지금은 최대 ${(1 / windowShare).toFixed(1)}배까지만 나올 수 있습니다.`,
    );
  }
  if (resolved.shrunk) {
    warnings.push(
      `이 종목은 사이클이 ${cycles.length}번이나 잡혀서, 바닥마다 ${requestedWindow.after}거래일씩 창을 주면 ` +
        `'상승장 시작 부근'이 전체의 ${(cycleWindowShare(bars.length, cycles, requestedWindow) * 100).toFixed(0)}%를 덮습니다. ` +
        `그러면 그 라벨이 아무것도 구분하지 못하므로(우연대비 천장이 1.x배로 눌린다) 뒤쪽 창을 ${window.after}거래일로 줄여 ` +
        `전체의 ${(MAX_WINDOW_SHARE * 100).toFixed(0)}% 한도에 맞췄습니다. 바닥 한참 뒤에 켜지는 확인형 지표는 이 창에서 적중으로 안 잡힙니다.`,
    );
  }
  warnings.push(
    "A등급 개수는 종목끼리 비교하면 안 됩니다. 사이클이 몇 번 잡혔는지에 크게 좌우됩니다 — 표본이 적으면(3번 이하) 앞뒤 기간 검증을 못 해 관문 ④에서 전부 탈락하고, 너무 잦으면 창이 넓어져 관문 ②가 막힙니다. 같은 모양의 합성 시세로 주기만 바꿔도 A등급 개수가 요동칩니다.",
  );
  warnings.push(
    "여기 지표는 대부분 '확인형'입니다. 바닥을 예측한 게 아니라 추세가 이미 바뀐 걸 알려줍니다. 리드타임이 양수면 바닥보다 늦게 떴다는 뜻입니다.",
  );
  if (years < 8 && /-USD$/.test(ticker)) {
    warnings.push(
      `데이터가 약 ${years.toFixed(1)}년치입니다. 그 이전 사이클은 분석에 포함되지 않았습니다.`,
    );
  }

  return {
    ticker,
    assetClass: /-USD$/.test(ticker) ? "코인" : "주식",
    thresholds,
    window,
    periodStart: bars[0]?.date ?? "",
    periodEnd: bars[lastIdx]?.date ?? "",
    totalBars: bars.length,
    years,
    cycles,
    regime: currentRegime(bars, thresholds),
    baseline,
    windowSharePct: windowShare * 100,
    windowShrunk: resolved.shrunk,
    windowRequested: requestedWindow,
    signals: evaluated,
    combos,
    commonKeys,
    now: { date: bars[lastIdx]?.date ?? "", on: nowCount.on, total: nowCount.total },
    cycleStarts,
    reliability,
    warnings,
  };
}

function tradingYears(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / (365.25 * 86400000);
}

/** LLM에 넘길 사실 요약. 여기 없는 숫자는 모델이 만들어낼 수 없다. */
export function factsForLlm(report: CycleReport, topN = 6): string {
  const brief = (s: GradedSignal) => ({
    지표: s.label,
    등급: s.grade,
    통과관문: `${s.passCount}/6`,
    적중: `${s.hitCount}/${report.cycles.length}`,
    리드타임: s.medianLeadDays,
    선행후행: s.timing,
    남은상승: s.medianCaptureSharePct == null ? null : Math.round(s.medianCaptureSharePct),
    우연대비: s.lift == null ? null : Number(s.lift.toFixed(2)),
    신호횟수: s.eventCount,
    우연일확률: s.chance == null ? null : Number(s.chance.toFixed(4)),
    보정후q: s.qValue == null ? null : Number(s.qValue.toFixed(4)),
    켜져있던기간비율: s.onSharePct == null ? null : Math.round(s.onSharePct),
    앞뒤기간모두통함: s.walkForward?.heldUp ?? null,
    "신호후1년_최대낙폭중앙값": s.drawdown.medianPct == null ? null : Math.round(s.drawdown.medianPct),
    "신호후1년_최악낙폭": s.drawdown.worstPct == null ? null : Math.round(s.drawdown.worstPct),
    기저율대비: s.edge == null ? null : Math.round(s.edge),
    현재: s.currentlyOn ? "켜짐" : "꺼짐",
  });

  const top = report.signals.slice(0, topN).map((s) => ({
    지표: s.label,
    적중: `${s.hitCount}/${report.cycles.length}`,
    리드타임: s.medianLeadDays,
    남은상승: s.medianCaptureSharePct == null ? null : Math.round(s.medianCaptureSharePct),
    정확도: s.precision == null ? null : Math.round(s.precision),
    우연대비: s.lift == null ? null : Number(s.lift.toFixed(2)),
    신호횟수: s.eventCount,
    우연일확률: s.chance == null ? null : Number(s.chance.toFixed(4)),
    보정후q: s.qValue == null ? null : Number(s.qValue.toFixed(4)),
    등급: s.grade,
    통과관문: `${s.passCount}/6`,
    선행후행: s.timing,
    앞뒤기간모두통함: s.walkForward?.heldUp ?? null,
    "신호후1년_최대낙폭중앙값": s.drawdown.medianPct == null ? null : Math.round(s.drawdown.medianPct),
    "이미켜짐(적중아님)": s.alreadyOnCount,
    창안신호: s.inWindowEvents.length,
    "1년수익률": s.forward["250"].avg == null ? null : Math.round(s.forward["250"].avg),
    "기저율대비": s.edge == null ? null : Math.round(s.edge),
    현재: s.currentlyOn ? "켜짐" : "꺼짐",
  }));

  return JSON.stringify({
    티커: report.ticker,
    기간: `${report.periodStart}~${report.periodEnd}`,
    사이클수: report.cycles.length,
    사이클: report.cycles.map((c) => ({
      바닥: c.troughDate,
      낙폭: c.drawdownPct == null ? null : Math.round(c.drawdownPct),
      이후상승: Math.round(c.gainPct),
    })),
    현재국면: report.regime.phase,
    현재켜짐: `${report.now.on}/${report.now.total}(${report.now.total ? Math.round((report.now.on / report.now.total) * 100) : 0}%)`,
    과거상승장시작시켜짐: report.cycleStarts.map(
      (c) => `${c.troughDate}:${c.on}/${c.total}(${Math.round(c.onPct)}%)${c.complete ? "" : "(진행중)"}`,
    ),
    기저율1년: report.baseline["250"].avg == null ? null : Math.round(report.baseline["250"].avg),
    "상승장시작부근이_전체기간에서_차지하는비율": Math.round(report.windowSharePct),
    상위지표: top,
    전사이클적중지표: report.commonKeys.length,
    "A등급(여섯관문통과)": report.signals.filter((s) => s.grade === "A").map(brief),
    상위조합: report.combos.slice(0, 3).map(brief),
    지금켜진A등급: report.signals
      .filter((s) => s.grade === "A" && s.currentlyOn)
      .map((s) => s.label),
  });
}

export const HORIZON_KEYS = HORIZONS.map(String);
