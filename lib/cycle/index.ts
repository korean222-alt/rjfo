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
import { andState, buildCombos, type ComboEvaluation } from "./combos";
import { gradeSignals, type GradedSignal } from "./grade";
import { assessPosition, type PositionAssessment, type PositionInput } from "./position";
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
export * from "./position";
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
  /**
   * 펀딩비가 실제로 몇 일치 붙었는지. 코인만.
   *
   * 펀딩 지표 3개가 성적표에 없을 때, 소스가 막힌 건지 원래 이 종목이 대상이 아닌지를
   * 화면에서 바로 구분하려고 싣는다. days=0이면 지표가 안 만들어진 게 정상이다.
   */
  funding: { days: number; first: string | null; last: string | null; signals: number };
  /**
   * 지금이 사이클의 어디쯤인지, 켜진 지표가 켜진 지 얼마나 됐는지, 그 지표가 꺼질 때까지
   * 기다리면 얼마를 반납하게 되는지.
   *
   * 등급표만으로는 "이미 많이 올라서 A등급이 다 켜진 상태"와 "지금 막 켜진 상태"가
   * 구별되지 않는다. 등급의 근거가 되는 숫자는 전부 '켜지는 날' 기준이기 때문이다.
   */
  position: PositionAssessment;
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

  const fundingDays = bars.filter((b) => b.funding_pct != null);
  const funding = {
    days: fundingDays.length,
    first: fundingDays[0]?.date ?? null,
    last: fundingDays[fundingDays.length - 1]?.date ?? null,
    signals: signals.filter((s) => s.key.startsWith("fund_")).length,
  };

  // '지금 위치'는 등급이 매겨진 것들만 본다. 조합은 구성 지표에서 상태를 되만든다
  // (buildCombos는 채점 결과만 돌려주고 상태 배열은 안 남긴다).
  const stateByKey = new Map(signals.map((s) => [s.key, s.state]));
  const positionInputs: PositionInput[] = [
    ...evaluated.flatMap((g) => {
      const state = stateByKey.get(g.key);
      return state ? [{ key: g.key, label: g.label, grade: g.grade, score: g.score, state }] : [];
    }),
    ...combos.flatMap((g) => {
      const a = stateByKey.get(g.members[0]);
      const b = stateByKey.get(g.members[1]);
      return a && b
        ? [{ key: g.key, label: g.label, grade: g.grade, score: g.score, state: andState(a, b) }]
        : [];
    }),
  ];
  const position = assessPosition(bars, cycles, positionInputs, thresholds, window.after);

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

  // '전 사이클 적중'은 말 그대로 전부여야 한다. 두 번만 채점된 지표가 2/2로
  // 여기 올라오면 이름이 거짓말이 된다.
  const commonKeys = evaluated
    .filter((s) => cycles.length > 0 && s.hitRate === 100 && s.coverage.full)
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
  // 이 앱의 가장 큰 오독을 막는 경고. 등급은 '켜지는 날'에 매겨졌는데 화면은 '켜져 있음'을 보여준다.
  const onGraded = position.onSignals.filter((s) => s.grade === "A" || s.grade === "B");
  if (onGraded.length) {
    const stale = onGraded.filter((s) => !s.fresh).length;
    warnings.push(
      `지금 켜져 있는 A·B등급이 ${onGraded.length}개이고 그중 ${stale}개는 등급을 잰 창(바닥 뒤 ${window.after}거래일)을 이미 벗어났습니다. ` +
        `등급표의 숫자는 전부 '그 지표가 켜지는 날' 기준이라 오래전에 켜진 지표에는 적용되지 않습니다 — ` +
        `'A등급이 켜져 있다'는 '지금 사도 된다'가 아닙니다. 지금 진입을 판단하려면 '지금 위치'의 진행도와 반납폭을 보세요.` +
        (position.medianFurtherDropToExitPct != null
          ? ` 이 지표들이 꺼질 때까지 기다리는 매도 규칙은 오늘 가격에서 중앙값 ${position.medianFurtherDropToExitPct.toFixed(0)}%를 더 반납합니다.`
          : ""),
    );
  }
  // 값이 최근 구간에만 있는 지표(펀딩비 등)는 사이클 두어 번으로만 채점된다.
  const partial = graded.filter(
    (s) => !s.coverage.full && (s.grade === "A" || s.grade === "B"),
  );
  if (partial.length) {
    warnings.push(
      `${partial.map((s) => s.label).join(", ")}는 값이 있는 기간이 짧아 사이클 ${cycles.length}번 중 ` +
        `${partial[0].coverage.cyclesCovered}번 안팎으로만 채점됐습니다. 적중률·우연대비의 분모를 그 구간으로 좁혀 ` +
        `부풀려지지 않게는 했지만, 표본이 적다는 사실은 그대로입니다 — 전 기간을 본 지표와 같은 등급이어도 근거의 두께가 다릅니다.`,
    );
  }
  warnings.push(
    "이 배터리에는 하락 지표가 없습니다. 여기 지표는 전부 상승 전환을 확인하는 용도로만 채점됐고, 매도 시점으로는 채점된 적이 없습니다. 꺼짐을 매도 신호로 쓰면 안 됩니다.",
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
    funding,
    position,
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

const round = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v);

/** LLM에 넘길 사실 요약. 여기 없는 숫자는 모델이 만들어낼 수 없다. */
export function factsForLlm(report: CycleReport, topN = 6): string {
  const brief = (s: GradedSignal) => ({
    지표: s.label,
    등급: s.grade,
    통과관문: `${s.passCount}/6`,
    적중: `${s.hitCount}/${s.coverage.cyclesCovered}`,
    리드타임: s.medianLeadDays,
    선행후행: s.timing,
    남은상승: s.medianCaptureSharePct == null ? null : Math.round(s.medianCaptureSharePct),
    우연대비: s.lift == null ? null : Number(s.lift.toFixed(2)),
    신호횟수: s.eventCount,
    우연일확률: s.chance == null ? null : Number(s.chance.toFixed(4)),
    보정후q: s.qValue == null ? null : Number(s.qValue.toFixed(4)),
    앞뒤기간모두통함: s.walkForward?.heldUp ?? null,
    "신호후1년_최대낙폭중앙값": s.drawdown.medianPct == null ? null : Math.round(s.drawdown.medianPct),
    "신호후1년_최악낙폭": s.drawdown.worstPct == null ? null : Math.round(s.drawdown.worstPct),
    기저율대비: s.edge == null ? null : Math.round(s.edge),
    현재: s.currentlyOn ? "켜짐" : "꺼짐",
    채점구간: s.coverage.full ? "전 기간" : `${s.coverage.fromDate}~ (${s.coverage.cyclesCovered}/${s.coverage.cyclesTotal}사이클)`,
  });

  const top = report.signals.slice(0, topN).map((s) => ({
    지표: s.label,
    적중: `${s.hitCount}/${s.coverage.cyclesCovered}`,
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
    지금위치: {
      단계: report.position.stage,
      바닥: report.position.cycle.troughDate,
      진행중: report.position.cycle.ongoing,
      바닥대비상승: round(report.position.cycle.gainPct),
      과거상승폭중앙값: round(report.position.cycle.medianPastGainPct),
      진행도퍼센트: round(report.position.cycle.progressPct),
      이미넘어선과거사이클수: `${report.position.cycle.exceededCount}/${report.position.cycle.pastGains.length}`,
      이번사이클고점: report.position.cycle.peakDate,
      고점대비현재: round(report.position.cycle.fromPeakPct),
      하락국면까지추가하락: round(report.position.cycle.furtherDropToBearPct),
      "켜진상위등급_창안": report.position.freshCount,
      "켜진상위등급_창밖": report.position.staleCount,
      지표꺼질때까지추가하락중앙값: round(report.position.medianFurtherDropToExitPct),
      켜진지표: report.position.onSignals.slice(0, 8).map((s) => ({
        지표: s.label,
        등급: s.grade,
        켜진날: s.onSinceDate,
        켜진지: s.daysOn,
        등급창안: s.fresh,
        고점대비지금: round(s.givebackNowPct),
        과거꺼진지점: round(s.medianExitGivebackPct),
        꺼질때까지추가하락: round(s.furtherDropToExitPct),
      })),
    },
  });
}

export const HORIZON_KEYS = HORIZONS.map(String);
