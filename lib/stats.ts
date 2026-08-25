import type {
  AnalysisResult,
  EnrichedBar,
  FilterSpec,
  ForwardReturns,
  MatchRow,
  StatBlock,
} from "@/types";
import { applyFilter, clusterIndices } from "./filter";
import { PRESET_SIGNAL_RULES } from "./presets";
import { computeRarity } from "./rarity";

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
 * 스펙에 신호 정리 규칙이 명시돼 있으면 그걸 쓰고, 없으면 프리셋 기본값을 쓴다.
 * 프리셋도 없으면 규칙 없음(조건을 만족한 날이 전부 신호).
 */
export function resolveSignalRule(spec: FilterSpec): AnalysisResult["signalRule"] {
  const preset = spec.preset ? PRESET_SIGNAL_RULES[spec.preset] : undefined;
  return {
    topPct: spec.top_pct ?? preset?.top_pct ?? 100,
    clusterGap: spec.cluster_gap ?? preset?.cluster_gap ?? 1,
    clusterPick: spec.cluster_pick ?? "rarest",
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
  const rule = resolveSignalRule(spec);

  // 희귀도는 전체 봉 기준으로 한 번만 매긴다 (같은 잣대를 모든 날에 적용하기 위해).
  const rarity = computeRarity(bars, spec);

  const rawIndices = applyFilter(bars, spec);

  // lookahead: "급등 직전" 류 — 미래 창 안에서 목표 수익률을 달성한 날만 남긴다.
  const lookahead = spec.lookahead;
  const passesLookahead = (i: number) => {
    if (!lookahead || !(lookahead.days > 0)) return true;
    const mx = maxForwardReturn(bars, i, lookahead.days);
    return mx != null && mx >= lookahead.min_return_pct;
  };
  const afterLookahead = rawIndices.filter(passesLookahead);
  const rawMatchCount = afterLookahead.length;

  // 국면 묶기 — 붙어 있는 매칭일을 하나로 묶되 대표일은 그 국면에서 가장 희귀한 날로 고른다.
  // 국면 안 어느 날이 제일 강하든 그 날이 살아남는다.
  let clusters = afterLookahead.map((i) => ({ index: i, size: 1, start: i, end: i }));
  if (cluster) {
    clusters = clusterIndices(afterLookahead, rule.clusterGap, rarity, rule.clusterPick);
  }

  // 희귀도 순위 컷 — 드문 것부터 상위 몇 %만 남긴다.
  // 시간 간격으로 솎아내지 않으므로, 강한 신호가 며칠을 연달아 떠도 전부 순위 위에 남는다.
  const beforeRank = clusters.length;
  if (rule.topPct < 100 && clusters.length > 1) {
    const keepCount = Math.max(1, Math.ceil(clusters.length * (rule.topPct / 100)));
    const ranked = [...clusters].sort((a, b) => {
      const ra = rarity[a.index] ?? -Infinity;
      const rb = rarity[b.index] ?? -Infinity;
      if (rb !== ra) return rb - ra;
      return a.index - b.index; // 동점이면 이른 날 우선 (결과가 매번 같도록)
    });
    const kept = new Set(ranked.slice(0, keepCount).map((c) => c.index));
    clusters = clusters.filter((c) => kept.has(c.index));
  }
  const rankedOutCount = beforeRank - clusters.length;

  const indices = clusters.map((c) => c.index);

  const matches: MatchRow[] = clusters.map((c, k) => {
    const i = c.index;
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
      clusterSize: c.size,
      clusterStart: bars[c.start].date,
      clusterEnd: bars[c.end].date,
      rarity: rarity[i],
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
    warnings.push("조건에 맞는 날이 없습니다. 조건을 완화해 보세요.");
  } else if (matches.length < 10) {
    warnings.push("표본이 너무 적어 통계적 의미 없음 (매칭 10일 미만).");
  }

  if (suppressedCount > 0) {
    const parts: string[] = [];
    if (cluster) {
      parts.push(
        `붙어 있는 날을 국면으로 묶어(gap ${rule.clusterGap}일) ` +
          (rule.clusterPick === "rarest"
            ? "국면마다 가장 희귀한 날만 남김"
            : "국면마다 가장 이른 날만 남김"),
      );
    }
    if (rankedOutCount > 0) parts.push(`희귀도 상위 ${rule.topPct}%만 남겨 ${rankedOutCount}개 제외`);
    warnings.push(
      `조건 충족 ${rawMatchCount}일 → 신호 ${matches.length}개. ${parts.join(" · ")}. ` +
        "시간 간격으로 자르지 않으므로 강한 신호는 연달아 떠도 빠지지 않습니다.",
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
    spec: {
      ...spec,
      top_pct: rule.topPct,
      cluster_gap: rule.clusterGap,
      cluster_pick: rule.clusterPick,
    },
    warnings,
    lookaheadUsed: Boolean(lookahead && lookahead.days > 0),
    clustered: cluster,
    rawMatchCount,
    suppressedCount,
    rankedOutCount,
    signalRule: rule,
  };
}
