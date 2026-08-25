import type { Condition, EnrichedBar, FilterSpec, Metric } from "@/types";
import { metricValue } from "./filter";

/**
 * 희귀도 — "이 종목 역사에서 이 날이 얼마나 드문 축인가"를 0~100으로 매긴다.
 *
 * 신호를 시간 간격으로 솎아내면(직전 신호 이후 N일 대기) 정작 중요한 날이 통째로
 * 사라진다. 대신 각 조건 지표가 그 종목의 전체 분포에서 어느 위치인지를 보고,
 * 드문 날만 남긴다. 이러면 몇 번을 연속으로 뜨든 강한 신호는 절대 버려지지 않는다.
 *
 *  - `>=` / `>` 조건: 값이 클수록 드물다 → 자기보다 작거나 같은 값의 비율
 *  - `<=` / `<` 조건: 값이 작을수록 드물다 → 자기보다 크거나 같은 값의 비율
 *
 * AND는 조건별 백분위의 평균(모든 축에서 고르게 드문가), OR은 최댓값(하나라도
 * 확실히 드문가)을 쓴다 — 스펙의 logic이 뜻하는 바를 그대로 따른다.
 */

/** 오름차순 배열에서 v 이하인 원소 개수. */
function countAtMost(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 오름차순 배열에서 v 미만인 원소 개수. */
function countBelow(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 조건에 등장하는 지표별로 전체 분포(정렬된 유한값)를 만들어 둔다. */
function buildDistributions(
  bars: EnrichedBar[],
  conditions: Condition[],
): Map<Metric, number[]> {
  const dists = new Map<Metric, number[]>();
  for (const c of conditions) {
    if (dists.has(c.metric)) continue;
    const values: number[] = [];
    for (const bar of bars) {
      const v = metricValue(bar, c.metric);
      if (v != null && isFinite(v)) values.push(v);
    }
    values.sort((a, b) => a - b);
    dists.set(c.metric, values);
  }
  return dists;
}

/** 한 조건에 대한 백분위(0~100). 분포가 비었으면 null. */
function conditionPercentile(
  sorted: number[],
  op: Condition["op"],
  v: number,
): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  // 값이 클수록 드문 조건인지, 작을수록 드문 조건인지에 따라 방향을 뒤집는다.
  const rarerWhenHigh = op === ">=" || op === ">";
  const count = rarerWhenHigh ? countAtMost(sorted, v) : n - countBelow(sorted, v);
  return (count / n) * 100;
}

/**
 * 봉별 희귀도(0~100). 조건 지표가 하나도 준비되지 않은 워밍업 구간은 null.
 * 분포는 전체 봉 기준으로 한 번만 만든다 (기간 필터와 무관하게 같은 잣대를 쓰기 위해).
 */
export function computeRarity(bars: EnrichedBar[], spec: FilterSpec): (number | null)[] {
  const conditions = spec.conditions ?? [];
  if (conditions.length === 0) return new Array(bars.length).fill(null);

  const dists = buildDistributions(bars, conditions);
  const useMax = spec.logic === "OR";

  return bars.map((bar) => {
    const scores: number[] = [];
    for (const c of conditions) {
      const v = metricValue(bar, c.metric);
      if (v == null || !isFinite(v)) continue;
      const p = conditionPercentile(dists.get(c.metric) ?? [], c.op, v);
      if (p != null) scores.push(p);
    }
    if (scores.length === 0) return null;
    return useMax
      ? Math.max(...scores)
      : scores.reduce((a, b) => a + b, 0) / scores.length;
  });
}
