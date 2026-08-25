import type { Condition, EnrichedBar, FilterSpec, Metric } from "@/types";

function metricValue(bar: EnrichedBar, metric: Metric): number | null {
  switch (metric) {
    case "volume":
      return bar.volume;
    case "dollar_volume":
      return bar.dollar_volume;
    case "volume_ratio_20d":
      return bar.volume_ratio_20d;
    case "volume_zscore_60d":
      return bar.volume_zscore_60d;
    case "close_change_pct":
      return bar.close_change_pct;
    case "abs_close_change_pct":
      return bar.abs_close_change_pct;
    case "close_position_in_range":
      return bar.close_position_in_range;
    case "range_pct":
      return bar.range_pct;
    case "up_down_vol_ratio_20d":
      return bar.up_down_vol_ratio_20d;
    case "obv_slope_20d":
      return bar.obv_slope_20d;
    case "atr_ratio_20d":
      return bar.atr_ratio_20d;
  }
}

function testCondition(bar: EnrichedBar, c: Condition): boolean {
  const v = metricValue(bar, c.metric);
  if (v == null || !isFinite(v)) return false; // 워밍업 구간은 자동 제외
  switch (c.op) {
    case ">=":
      return v >= c.value;
    case "<=":
      return v <= c.value;
    case ">":
      return v > c.value;
    case "<":
      return v < c.value;
  }
}

function inPeriod(date: string, period?: FilterSpec["period"]): boolean {
  if (!period) return true;
  // 날짜는 전부 YYYY-MM-DD 문자열 비교 (타임존 변환 없음)
  if (period.start && date < period.start) return false;
  if (period.end && date > period.end) return false;
  return true;
}

/** 조건(+기간)을 만족하는 봉의 인덱스를 반환. lookahead는 stats 단계에서 적용한다. */
export function applyFilter(bars: EnrichedBar[], spec: FilterSpec): number[] {
  const conditions = spec.conditions ?? [];
  const out: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!inPeriod(bar.date, spec.period)) continue;
    if (conditions.length === 0) continue; // 조건 없는 스펙은 전체 매칭시키지 않는다

    const pass =
      spec.logic === "OR"
        ? conditions.some((c) => testCondition(bar, c))
        : conditions.every((c) => testCondition(bar, c));

    if (pass) out.push(i);
  }
  return out;
}

/**
 * 연속된(또는 gap 이내로 붙어있는) 매칭일을 클러스터로 묶어 중복 카운트를 막는다.
 * 각 클러스터의 첫 날만 남긴다.
 */
export function clusterIndices(
  indices: number[],
  gap = 1,
): { kept: number[]; sizes: number[] } {
  const kept: number[] = [];
  const sizes: number[] = [];
  for (const idx of indices) {
    const last = kept.length ? kept[kept.length - 1] : null;
    const lastEnd = last == null ? null : last + sizes[sizes.length - 1] - 1;
    if (lastEnd != null && idx - lastEnd <= gap) {
      sizes[sizes.length - 1] = idx - last! + 1;
    } else {
      kept.push(idx);
      sizes.push(1);
    }
  }
  return { kept, sizes };
}
