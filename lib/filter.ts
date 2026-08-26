import { testMaCondition } from "@/lib/ma";
import type { Condition, EnrichedBar, FilterSpec, Metric, MetricCondition } from "@/types";

function isMetricCondition(c: Condition): c is MetricCondition {
  return c.kind !== "ma_cross" && c.kind !== "ma_touch";
}

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
    case "funding_pct":
      return bar.funding_pct;
    case "funding_zscore_60d":
      return bar.funding_zscore_60d;
    case "funding_z_abs":
      return bar.funding_z_abs;
    case "funding_abs":
      return bar.funding_abs;
    case "funding_flip":
      return bar.funding_flip;
  }
}

function testMetricCondition(bar: EnrichedBar, c: MetricCondition): boolean {
  const v = metricValue(bar, c.metric);
  if (v == null || !isFinite(v)) return false;
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

function testCondition(bars: EnrichedBar[], i: number, c: Condition): boolean {
  const ma = testMaCondition(bars, i, c);
  if (ma != null) return ma;
  if (isMetricCondition(c)) return testMetricCondition(bars[i], c);
  return false;
}

function inPeriod(date: string, period?: FilterSpec["period"]): boolean {
  if (!period) return true;
  if (period.start && date < period.start) return false;
  if (period.end && date > period.end) return false;
  return true;
}

export function applyFilter(bars: EnrichedBar[], spec: FilterSpec): number[] {
  const conditions = spec.conditions ?? [];
  const out: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!inPeriod(bar.date, spec.period)) continue;
    if (conditions.length === 0) continue;

    const pass =
      spec.logic === "OR"
        ? conditions.some((c) => testCondition(bars, i, c))
        : conditions.every((c) => testCondition(bars, i, c));

    if (pass) out.push(i);
  }
  return out;
}

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
