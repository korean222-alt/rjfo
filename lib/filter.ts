import type { Condition, EnrichedBar, FilterSpec, Metric } from "@/types";

/** 지표 이름 → 그 봉의 값. 희귀도 계산에서도 같은 표를 쓴다. */
export function metricValue(bar: EnrichedBar, metric: Metric): number | null {
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
    case "up_day_ratio_20d":
      return bar.up_day_ratio_20d;
    case "obv_slope_20d":
      return bar.obv_slope_20d;
    case "obv_slope_60d":
      return bar.obv_slope_60d;
    case "atr_ratio_20d":
      return bar.atr_ratio_20d;
    case "range_ratio_20d":
      return bar.range_ratio_20d;
    case "close_vs_sma20_pct":
      return bar.close_vs_sma20_pct;
    case "dist_from_high_60d_pct":
      return bar.dist_from_high_60d_pct;
    case "dist_from_low_60d_pct":
      return bar.dist_from_low_60d_pct;
    case "vol_ma_ratio_20_50":
      return bar.vol_ma_ratio_20_50;
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

/** 한 봉이 조건 집합(로직 포함)을 만족하는지. 기간은 보지 않는다. */
function passesConditions(bar: EnrichedBar, spec: FilterSpec): boolean {
  const conditions = spec.conditions ?? [];
  if (conditions.length === 0) return false; // 조건 없는 스펙은 전체 매칭시키지 않는다
  return spec.logic === "OR"
    ? conditions.some((c) => testCondition(bar, c))
    : conditions.every((c) => testCondition(bar, c));
}

/** 조건(+기간)을 만족하는 봉의 인덱스를 반환. lookahead는 stats 단계에서 적용한다. */
export function applyFilter(bars: EnrichedBar[], spec: FilterSpec): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (!inPeriod(bars[i].date, spec.period)) continue;
    if (passesConditions(bars[i], spec)) out.push(i);
  }
  return out;
}

export type Cluster = {
  /** 이 국면을 대표하는 봉의 인덱스 */
  index: number;
  /** 국면에 묶인 거래일 수 */
  size: number;
  /** 국면의 첫 날 / 마지막 날 인덱스 */
  start: number;
  end: number;
};

export type ClusterPick = "rarest" | "first";

/**
 * 붙어 있는 매칭일을 하나의 "국면"으로 묶는다.
 *
 * 상태 지표(20일 롤링)는 한 국면이 통째로 조건을 만족해 신호 수십 개로 부풀려진다.
 * 그렇다고 시간 간격으로 솎아내면 정작 그 국면에서 제일 중요한 날이 잘려나간다.
 * 그래서 국면은 묶되, 대표일을 **희귀도가 가장 높은 날**로 고른다 — 몇 개로 줄이든
 * 남는 건 항상 그 국면에서 가장 강한 날이다.
 *
 * pick이 "first"면 국면의 첫 날(= 가장 이른 진입 시점)을 대표로 삼는다.
 *
 * @param gap  이만큼 이내로 떨어진 매칭일은 같은 국면으로 본다 (1 = 연속일만)
 * @param rarity  봉별 희귀도. 없으면 첫 날을 대표로 쓴다.
 */
export function clusterIndices(
  indices: number[],
  gap = 1,
  rarity?: (number | null)[],
  pick: ClusterPick = "rarest",
): Cluster[] {
  if (!indices.length) return [];

  // 1) 먼저 gap 기준으로 국면 경계를 나눈다.
  const groups: number[][] = [];
  let current: number[] = [indices[0]];
  for (let k = 1; k < indices.length; k++) {
    const idx = indices[k];
    if (idx - current[current.length - 1] <= gap) current.push(idx);
    else {
      groups.push(current);
      current = [idx];
    }
  }
  groups.push(current);

  // 2) 각 국면의 대표일을 고른다.
  return groups.map((group) => {
    const start = group[0];
    const end = group[group.length - 1];
    let index = start;

    if (pick === "rarest" && rarity) {
      let best = -Infinity;
      for (const i of group) {
        const r = rarity[i];
        if (r != null && r > best) {
          best = r;
          index = i;
        }
      }
    }

    return { index, size: end - start + 1, start, end };
  });
}
