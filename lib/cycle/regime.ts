/**
 * "상승장이 시작된 날"을 기계가 정의한다. 이 파일이 틀리면 나머지 통계는 전부 무의미하다.
 *
 * 방식: 종가 기준 지그재그.
 *   - 하락 국면: 최저가를 추적한다. 그 최저가 대비 bullPct% 이상 오르면
 *     그 최저가를 '바닥(= 상승장 시작일)'으로 확정하고 상승 국면으로 전환.
 *   - 상승 국면: 최고가를 추적한다. 그 최고가 대비 bearPct% 이상 빠지면
 *     그 최고가를 '고점'으로 확정하고 하락 국면으로 전환.
 *
 * 확정된 바닥은 "그 뒤로 bearPct 이상 되밀리지 않고 bullPct 이상 오른 저점"이다.
 * 라벨링은 원래 사후적(hindsight)인 작업이라 여기서 미래를 보는 건 정상이다.
 * 지표 평가 쪽(evaluate.ts)에서만 미래 참조가 금지된다.
 *
 * 임계값은 자산군마다 다르다. 코인은 60% 낙폭이 흔하고 주식은 20%면 약세장이다.
 */

import type { Bar } from "@/types";

export type CycleThresholds = {
  /** 고점 대비 이만큼 빠지면 하락 국면으로 본다 (%). */
  bearPct: number;
  /** 저점 대비 이만큼 오르면 상승 국면으로 본다 (%). */
  bullPct: number;
};

export const CRYPTO_THRESHOLDS: CycleThresholds = { bearPct: 40, bullPct: 50 };
export const STOCK_THRESHOLDS: CycleThresholds = { bearPct: 20, bullPct: 25 };

export type Cycle = {
  /** 직전 고점 (첫 사이클은 데이터 시작점일 수 있다). */
  peakDate: string | null;
  peakIdx: number | null;
  peakClose: number | null;
  /** 상승장 시작일 = 확정된 바닥. */
  troughDate: string;
  troughIdx: number;
  troughClose: number;
  /** 고점 → 바닥 낙폭 (%, 음수). */
  drawdownPct: number | null;
  /** 바닥 → 다음 고점 상승률 (%). 진행 중이면 현재까지. */
  gainPct: number;
  /** 다음 고점. 아직 진행 중이면 null. */
  nextPeakDate: string | null;
  nextPeakIdx: number | null;
  nextPeakClose: number;
  /** 다음 고점이 확정됐는지 (= 사이클이 끝났는지). */
  closed: boolean;
};

export function thresholdsFor(ticker: string): CycleThresholds {
  return /-USD$/.test(ticker) ? CRYPTO_THRESHOLDS : STOCK_THRESHOLDS;
}

type Pivot = { kind: "peak" | "trough"; idx: number };

/**
 * 종가 지그재그. 교대로 나타나는 고점/저점을 확정된 것만 뽑는다.
 *
 * 데이터 시작점 처리가 까다롭다. 보통 우리는 "최근 N년"을 받으므로 시작 시점이
 * 이미 상승 중인 경우가 흔한데, 그때 첫 봉이 그 구간의 최저가라서 아무 조치 없이
 * 돌리면 '데이터 시작일 = 상승장 시작일'이라는 가짜 사이클이 하나 생긴다.
 *
 * 그래서 방향이 정해지기 전(unknown) 구간에서는, 그 저점 앞에 실제로
 * bearPct 이상의 하락이 관측됐을 때만 바닥으로 인정한다. 하락을 못 본 저점은
 * 그냥 데이터 경계일 뿐 바닥이 아니다.
 */
export function findPivots(bars: Bar[], t: CycleThresholds): Pivot[] {
  const pivots: Pivot[] = [];
  if (bars.length < 2) return pivots;

  const up = 1 + t.bullPct / 100;
  const down = 1 - t.bearPct / 100;

  let state: "unknown" | "up" | "down" = "unknown";
  let maxIdx = 0;
  let minIdx = 0;
  /** minIdx가 갱신된 시점까지의 최고점. '그 저점 앞에 하락이 있었나' 판정용. */
  let anchorPeakIdx = 0;

  for (let i = 1; i < bars.length; i++) {
    const c = bars[i].close;

    if (state === "unknown") {
      if (c > bars[maxIdx].close) maxIdx = i;
      if (c < bars[minIdx].close) {
        minIdx = i;
        anchorPeakIdx = maxIdx;
      }

      if (c >= bars[minIdx].close * up) {
        if (bars[minIdx].close <= bars[anchorPeakIdx].close * down) {
          pivots.push({ kind: "peak", idx: anchorPeakIdx });
          pivots.push({ kind: "trough", idx: minIdx });
        }
        state = "up";
        maxIdx = i;
      } else if (c <= bars[maxIdx].close * down) {
        pivots.push({ kind: "peak", idx: maxIdx });
        state = "down";
        minIdx = i;
      }
      continue;
    }

    if (state === "up") {
      if (c > bars[maxIdx].close) maxIdx = i;
      if (c <= bars[maxIdx].close * down) {
        pivots.push({ kind: "peak", idx: maxIdx });
        state = "down";
        minIdx = i;
      }
    } else {
      if (c < bars[minIdx].close) minIdx = i;
      if (c >= bars[minIdx].close * up) {
        pivots.push({ kind: "trough", idx: minIdx });
        state = "up";
        maxIdx = i;
      }
    }
  }
  return pivots;
}

/**
 * 확정된 바닥들을 상승 사이클로 묶는다.
 *
 * 데이터 맨 앞 구간은 이미 상승 중이었을 수 있어서 첫 바닥의 '직전 고점'이 없을 수 있다.
 * 그때 peak*는 null이고 낙폭도 null이다 (없는 값을 지어내지 않는다).
 */
export function findCycles(bars: Bar[], t: CycleThresholds): Cycle[] {
  const pivots = findPivots(bars, t);
  const cycles: Cycle[] = [];
  const lastIdx = bars.length - 1;

  for (let p = 0; p < pivots.length; p++) {
    const pivot = pivots[p];
    if (pivot.kind !== "trough") continue;

    const prev = p > 0 && pivots[p - 1].kind === "peak" ? pivots[p - 1] : null;
    const next = p + 1 < pivots.length && pivots[p + 1].kind === "peak" ? pivots[p + 1] : null;

    const troughClose = bars[pivot.idx].close;
    const closed = next != null;

    // 진행 중인 사이클은 바닥 이후 지금까지의 최고 종가를 '아직 확정 안 된 고점'으로 쓴다.
    let runningPeakIdx = pivot.idx;
    if (!closed) {
      for (let i = pivot.idx; i <= lastIdx; i++) {
        if (bars[i].close > bars[runningPeakIdx].close) runningPeakIdx = i;
      }
    }
    const peakIdxAfter = closed ? next!.idx : runningPeakIdx;
    const peakCloseAfter = bars[peakIdxAfter].close;

    cycles.push({
      peakDate: prev ? bars[prev.idx].date : null,
      peakIdx: prev ? prev.idx : null,
      peakClose: prev ? bars[prev.idx].close : null,
      troughDate: bars[pivot.idx].date,
      troughIdx: pivot.idx,
      troughClose,
      drawdownPct: prev ? ((troughClose - bars[prev.idx].close) / bars[prev.idx].close) * 100 : null,
      gainPct: troughClose > 0 ? ((peakCloseAfter - troughClose) / troughClose) * 100 : 0,
      nextPeakDate: closed ? bars[peakIdxAfter].date : null,
      nextPeakIdx: closed ? peakIdxAfter : null,
      nextPeakClose: peakCloseAfter,
      closed,
    });
  }
  return cycles;
}

/** 현재 국면. 마지막 피벗이 바닥이면 상승, 고점이면 하락. */
export function currentRegime(bars: Bar[], t: CycleThresholds): {
  phase: "상승" | "하락" | "판정불가";
  since: string | null;
  fromPivotPct: number | null;
} {
  const pivots = findPivots(bars, t);
  const last = pivots[pivots.length - 1];
  if (!last || !bars.length) return { phase: "판정불가", since: null, fromPivotPct: null };
  const ref = bars[last.idx].close;
  const now = bars[bars.length - 1].close;
  return {
    phase: last.kind === "trough" ? "상승" : "하락",
    since: bars[last.idx].date,
    fromPivotPct: ref > 0 ? ((now - ref) / ref) * 100 : null,
  };
}
