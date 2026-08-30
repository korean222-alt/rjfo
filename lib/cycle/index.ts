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
  type ForwardStat,
  type MatchWindow,
  type SignalEvaluation,
} from "./evaluate";
import {
  currentRegime,
  findCycles,
  thresholdsFor,
  type Cycle,
  type CycleThresholds,
} from "./regime";
import { buildSignals, type SignalSeries } from "./signals";

export * from "./evaluate";
export * from "./regime";
export * from "./signals";

/** 바닥 며칠 뒤 시점에서 '그때 켜져 있던 지표 수'를 재는지 (거래일). */
const CYCLE_START_OFFSET = 30;

export type CycleStartSnapshot = {
  troughDate: string;
  measuredDate: string;
  on: number;
  total: number;
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
  signals: SignalEvaluation[];
  /** 과거 상승장 시작을 전부 잡아낸 지표들 (사용자가 말한 "공통으로 가리킨 것"). */
  commonKeys: string[];
  now: { date: string; on: number; total: number };
  cycleStarts: CycleStartSnapshot[];
  reliability: "매우 낮음" | "낮음" | "보통";
  warnings: string[];
};

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
  const window: MatchWindow = {
    before: opts.window?.before ?? DEFAULT_WINDOW.before,
    after: opts.window?.after ?? DEFAULT_WINDOW.after,
  };

  const cycles = findCycles(bars, thresholds);
  const signals: SignalSeries[] = buildSignals(bars);
  const baseline = baselineStats(bars);

  const windowShare = cycleWindowShare(bars.length, cycles, window);
  const evaluated = signals
    .map((s) => evaluateSignal(bars, s, cycles, baseline, windowShare, { window }))
    .sort((a, b) => b.score - a.score);

  const lastIdx = bars.length - 1;
  const nowCount = onCountAt(signals, lastIdx);

  const cycleStarts: CycleStartSnapshot[] = cycles.map((c) => {
    const idx = Math.min(lastIdx, c.troughIdx + CYCLE_START_OFFSET);
    const counted = onCountAt(signals, idx);
    return {
      troughDate: c.troughDate,
      measuredDate: bars[idx].date,
      on: counted.on,
      total: counted.total,
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

  // 다중검정: 30개를 재면 '우연일 확률 5% 미만'짜리가 그냥 한두 개 나온다.
  // 그 기대 개수를 실제 개수와 나란히 보여줘야 사용자가 속지 않는다.
  const significant = evaluated.filter((s) => s.chance != null && s.chance < 0.05).length;
  const expectedByChance = evaluated.length * 0.05;
  warnings.push(
    `지표 ${evaluated.length}개를 한꺼번에 검사했습니다. 여러 개를 동시에 시험하면 그중 일부는 우연히 좋아 보입니다(다중검정). ` +
      `'우연일 확률 5% 미만'인 지표가 지금 ${significant}개인데, 아무 의미 없는 지표만 ${evaluated.length}개 늘어놔도 평균 ${expectedByChance.toFixed(1)}개는 그렇게 나옵니다.`,
  );
  if (cycles.length) {
    warnings.push(
      `전체 기간의 ${(windowShare * 100).toFixed(0)}%가 '상승장 시작 부근'입니다. 자주 켜지는 지표는 그것만으로도 적중률이 높게 나오므로, 적중률보다 '우연대비' 배수를 보세요.`,
    );
  }
  // 창이 기간의 절반을 넘으면 검정이 성립하지 않는다. 이걸 말해주지 않으면
  // 사용자는 "다 맞았는데 왜 우연일 확률이 높지?"에서 계산이 틀렸다고 생각하게 된다.
  if (windowShare > 0.5) {
    warnings.push(
      `주의: '상승장 시작 부근'이 전체 기간의 ${(windowShare * 100).toFixed(0)}%나 됩니다. ` +
        `${years.toFixed(1)}년 안에 상승장 시작이 ${cycles.length}번으로 잡혔기 때문입니다(기준: 고점 대비 -${thresholds.bearPct}% 후 +${thresholds.bullPct}%). ` +
        `아무 날이나 찍어도 ${(windowShare * 100).toFixed(0)}%는 맞는 상황이라, 어떤 지표든 정확도가 그 근처에 붙고 우연대비는 1배, 우연일 확률은 높게 나옵니다. ` +
        `지표가 나쁜 게 아니라 이 종목에는 이 기준이 너무 헐거워서 검정이 성립하지 않는 것입니다. 변동성이 큰 종목일수록 기준을 높여야 합니다.`,
    );
  }
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
    signals: evaluated,
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
  const top = report.signals.slice(0, topN).map((s) => ({
    지표: s.label,
    적중: `${s.hitCount}/${report.cycles.length}`,
    리드타임: s.medianLeadDays,
    남은상승: s.medianCaptureSharePct == null ? null : Math.round(s.medianCaptureSharePct),
    정확도: s.precision == null ? null : Math.round(s.precision),
    우연대비: s.lift == null ? null : Number(s.lift.toFixed(2)),
    신호횟수: s.eventCount,
    우연일확률: s.chance == null ? null : Number(s.chance.toFixed(4)),
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
    현재켜짐: `${report.now.on}/${report.now.total}`,
    과거상승장시작시켜짐: report.cycleStarts.map((c) => `${c.troughDate}:${c.on}/${c.total}`),
    기저율1년: report.baseline["250"].avg == null ? null : Math.round(report.baseline["250"].avg),
    "상승장시작부근이_전체기간에서_차지하는비율": Math.round(report.windowSharePct),
    상위지표: top,
    전사이클적중지표: report.commonKeys.length,
  });
}

export const HORIZON_KEYS = HORIZONS.map(String);
