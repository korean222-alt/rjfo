import type {
  AnalysisResult,
  EnrichedBar,
  FilterSpec,
  ForwardReturns,
  MatchRow,
  StatBlock,
} from "@/types";
import { applyFilter, clusterIndices, enforceMinGap } from "./filter";
import { PRESET_TRIGGERS } from "./presets";

export const HIT_THRESHOLD_PCT = 10; // "성공" 정의: 20거래일 안에 +10% 이상
export const HORIZON = 20;

/** i번 봉 종가 대비 i+n번 봉 종가 수익률(%). 미래 봉이 모자라면 null. */
export function forwardReturn(
  bars: EnrichedBar[],
  i: number,
  n: number,
): number | null {
  const j = i + n;
  if (j >= bars.length) return null;
  const base = bars[i].close;
  if (!(base > 0)) return null;
  return ((bars[j].close - base) / base) * 100;
}

/** i번 봉 종가 대비 향후 n거래일 고점 기준 최대 수익률(%). 창이 모자라면 null. */
export function maxForwardReturn(
  bars: EnrichedBar[],
  i: number,
  n: number,
): number | null {
  if (i + n >= bars.length) return null;
  const base = bars[i].close;
  if (!(base > 0)) return null;
  let peak = -Infinity;
  for (let k = i + 1; k <= i + n; k++) peak = Math.max(peak, bars[k].high);
  return ((peak - base) / base) * 100;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 인덱스 집합에 대한 승률 / 평균 / 중앙값. 전방 창이 없는 날은 제외한다. */
function summarize(bars: EnrichedBar[], indices: number[]): StatBlock & { sampleCount: number } {
  const returns20: number[] = [];
  const maxReturns: number[] = [];

  for (const i of indices) {
    const r20 = forwardReturn(bars, i, HORIZON);
    const mx = maxForwardReturn(bars, i, HORIZON);
    if (r20 != null) returns20.push(r20);
    if (mx != null) maxReturns.push(mx);
  }

  const hits = maxReturns.filter((r) => r >= HIT_THRESHOLD_PCT).length;

  return {
    sampleCount: returns20.length,
    hitRate: maxReturns.length ? (hits / maxReturns.length) * 100 : null,
    avgReturn20d: mean(returns20),
    medianReturn20d: median(returns20),
  };
}

function inPeriod(date: string, period?: FilterSpec["period"]): boolean {
  if (!period) return true;
  if (period.start && date < period.start) return false;
  if (period.end && date > period.end) return false;
  return true;
}

export type AnalyzeOptions = {
  /** 연속 매칭일을 하나로 묶을지 (중복 카운트 방지). 기본 true. */
  cluster?: boolean;
};

/**
 * 스펙에 발화 규칙이 명시돼 있으면 그걸 쓰고, 없으면 프리셋 기본값을 쓴다.
 * 프리셋도 없으면 규칙 없음(예전 동작 그대로).
 */
export function resolveTrigger(spec: FilterSpec): { freshOnly: boolean; minGapDays: number } {
  const preset = spec.preset ? PRESET_TRIGGERS[spec.preset] : undefined;
  return {
    freshOnly: spec.fresh_only ?? preset?.fresh_only ?? false,
    minGapDays: spec.min_gap_days ?? preset?.min_gap_days ?? 0,
  };
}

/**
 * 필터 적용 → 매칭일 전방 수익률 → base rate와 비교.
 *
 * baseline이 이 앱의 핵심이다. 조건에 걸린 날의 승률이 45%인데 아무 날이나 골라도 44%라면
 * 그 조건은 아무것도 발견한 게 아니다.
 */
export function analyze(
  ticker: string,
  bars: EnrichedBar[],
  spec: FilterSpec,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const cluster = options.cluster !== false;
  const warnings: string[] = [];
  const trigger = resolveTrigger(spec);

  // 발화 규칙을 적용한 스펙 / 적용하지 않은 원본, 두 갈래를 함께 센다.
  // "조건은 120일 충족했는데 신호는 6개"를 화면에서 그대로 보여주기 위해서다.
  const effectiveSpec: FilterSpec = { ...spec, fresh_only: trigger.freshOnly };
  const rawIndices = applyFilter(bars, spec, { applyTrigger: false });
  let indices = applyFilter(bars, effectiveSpec);

  // lookahead: "급등 직전" 류 — 미래 창 안에서 목표 수익률을 달성한 날만 남긴다.
  const lookahead = spec.lookahead;
  const passesLookahead = (i: number) => {
    if (!lookahead || !(lookahead.days > 0)) return true;
    const mx = maxForwardReturn(bars, i, lookahead.days);
    return mx != null && mx >= lookahead.min_return_pct;
  };
  const rawMatchCount = rawIndices.filter(passesLookahead).length;
  indices = indices.filter(passesLookahead);

  let sizes: number[] = indices.map(() => 1);
  if (cluster) {
    const c = clusterIndices(indices);
    indices = c.kept;
    sizes = c.sizes;
  }

  // 최소 간격: 상태 지표가 임계값 근처에서 껌뻑이며 같은 국면을 여러 번 발화하는 걸 막는다.
  if (trigger.minGapDays > 0) {
    const kept = enforceMinGap(indices, trigger.minGapDays);
    const keptSet = new Set(kept);
    sizes = sizes.filter((_, k) => keptSet.has(indices[k]));
    indices = kept;
  }

  const matches: MatchRow[] = indices.map((i, k) => {
    const b = bars[i];
    const forwardReturns: ForwardReturns = {
      d5: forwardReturn(bars, i, 5),
      d20: forwardReturn(bars, i, 20),
      d60: forwardReturn(bars, i, 60),
    };
    return {
      date: b.date,
      volume: b.volume,
      volumeRatio: b.volume_ratio_20d,
      closeChangePct: b.close_change_pct,
      closePosition: b.close_position_in_range,
      close: b.close,
      forwardReturns,
      maxForwardReturn20d: maxForwardReturn(bars, i, HORIZON),
      clusterSize: sizes[k],
    };
  });

  const stats = summarize(bars, indices);

  // baseline: 같은 기간의 모든 거래일에 대해 동일한 계산
  const baselineIndices: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (inPeriod(bars[i].date, spec.period)) baselineIndices.push(i);
  }
  const baseline = summarize(bars, baselineIndices);

  const suppressedCount = Math.max(0, rawMatchCount - matches.length);

  if (matches.length === 0) {
    warnings.push(
      rawMatchCount > 0
        ? `조건은 ${rawMatchCount}일 충족했지만 발화 규칙(첫 진입만 · 최소 간격 ${trigger.minGapDays}일)을 통과한 신호가 없습니다. 아래에서 규칙을 완화해 보세요.`
        : "조건에 맞는 날이 없습니다. 조건을 완화해 보세요.",
    );
  } else if (matches.length < 10) {
    warnings.push("표본이 너무 적어 통계적 의미 없음 (매칭 10일 미만).");
  }

  if (suppressedCount > 0) {
    const parts: string[] = [];
    if (trigger.freshOnly) parts.push("첫 진입만");
    if (trigger.minGapDays > 0) parts.push(`최소 간격 ${trigger.minGapDays}일`);
    if (cluster) parts.push("연속일 묶기");
    warnings.push(
      `조건 충족 ${rawMatchCount}일 중 ${suppressedCount}일을 ${parts.join(" · ")} 규칙으로 묶어 신호 ${matches.length}개로 정리했습니다.`,
    );
  }

  const withoutWindow = matches.length - stats.sampleCount;
  if (withoutWindow > 0) {
    warnings.push(
      `최근 ${withoutWindow}일은 20거래일이 아직 지나지 않아 수익률 통계에서 제외했습니다.`,
    );
  }

  return {
    ticker,
    totalBars: bars.length,
    periodStart: bars[0]?.date ?? "",
    periodEnd: bars[bars.length - 1]?.date ?? "",
    matches: [...matches].reverse(), // 최신순
    stats: { ...stats, matchCount: matches.length },
    baseline,
    edge: {
      hitRateDiff:
        stats.hitRate != null && baseline.hitRate != null
          ? stats.hitRate - baseline.hitRate
          : null,
      avgReturnDiff:
        stats.avgReturn20d != null && baseline.avgReturn20d != null
          ? stats.avgReturn20d - baseline.avgReturn20d
          : null,
    },
    spec: { ...spec, fresh_only: trigger.freshOnly, min_gap_days: trigger.minGapDays },
    warnings,
    lookaheadUsed: Boolean(lookahead && lookahead.days > 0),
    clustered: cluster,
    rawMatchCount,
    suppressedCount,
    trigger,
  };
}
