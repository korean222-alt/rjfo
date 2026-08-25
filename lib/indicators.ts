import type { Bar, EnrichedBar } from "@/types";

/** 최근 n개(현재 봉 포함) 단순평균. 구간이 모자라면 null. */
function sma(values: number[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) sum += values[k];
  return sum / n;
}

/** null이 하나라도 있으면 계산하지 않는 단순평균. */
function nullableSma(values: (number | null)[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const value = values[k];
    if (value == null) return null;
    sum += value;
  }
  return sum / n;
}

/** 최근 n개(현재 봉 포함) 모집단 표준편차와 평균. */
function meanStd(
  values: number[],
  i: number,
  n: number,
): { mean: number; std: number } | null {
  if (i < n - 1) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) sum += values[k];
  const mean = sum / n;
  let sq = 0;
  for (let k = i - n + 1; k <= i; k++) sq += (values[k] - mean) ** 2;
  return { mean, std: Math.sqrt(sq / n) };
}

/** 최근 n봉 구간의 선형회귀 기울기 (x = 0..n-1, 단위: 봉당 변화량). */
function regressionSlope(values: number[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  const xMean = (n - 1) / 2;
  let yMean = 0;
  for (let k = i - n + 1; k <= i; k++) yMean += values[k];
  yMean /= n;

  let num = 0;
  let den = 0;
  for (let j = 0; j < n; j++) {
    const dx = j - xMean;
    num += dx * (values[i - n + 1 + j] - yMean);
    den += dx * dx;
  }
  return den === 0 ? null : num / den;
}

/**
 * Bar[] → 파생 지표가 붙은 EnrichedBar[].
 * 워밍업 구간(20~60봉)의 지표는 null이며, 필터에서 자동으로 제외된다.
 */
export function enrich(bars: Bar[]): EnrichedBar[] {
  const n = bars.length;
  const volumes = bars.map((b) => b.volume);

  // OBV: 상승일 +volume, 하락일 -volume 누적
  const obv: number[] = new Array(n);
  let running = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const prev = bars[i - 1].close;
      if (bars[i].close > prev) running += bars[i].volume;
      else if (bars[i].close < prev) running -= bars[i].volume;
    }
    obv[i] = running;
  }

  // ATR(14): Wilder 스무딩
  const tr: number[] = new Array(n);
  const atr: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    tr[i] =
      i === 0
        ? b.high - b.low
        : Math.max(
            b.high - b.low,
            Math.abs(b.high - bars[i - 1].close),
            Math.abs(b.low - bars[i - 1].close),
          );
  }
  for (let i = 14; i < n; i++) {
    if (i === 14) {
      let sum = 0;
      for (let k = 1; k <= 14; k++) sum += tr[k];
      atr[i] = sum / 14;
    } else {
      atr[i] = ((atr[i - 1] as number) * 13 + tr[i]) / 14;
    }
  }

  return bars.map((b, i) => {
    const vol_ma20 = sma(volumes, i, 20);
    const vol_ma50 = sma(volumes, i, 50);
    const atr_ma20 = nullableSma(atr, i, 20);
    const atr_ratio_20d =
      atr[i] != null && atr_ma20 != null && atr_ma20 > 0 ? atr[i]! / atr_ma20 : null;

    const z60 = meanStd(volumes, i, 60);
    const volume_zscore_60d =
      z60 && z60.std > 0 ? (b.volume - z60.mean) / z60.std : null;

    const prevClose = i > 0 ? bars[i - 1].close : null;
    const close_change_pct =
      prevClose != null && prevClose > 0
        ? ((b.close - prevClose) / prevClose) * 100
        : null;

    // high == low 인 봉은 0으로 나누기 → 0.5로 처리
    const span = b.high - b.low;
    const close_position_in_range = span > 0 ? (b.close - b.low) / span : 0.5;

    // 최근 20봉 중 상승일 거래량 합 ÷ 하락일 거래량 합 (직전 종가가 필요하므로 i>=20)
    let up_down_vol_ratio_20d: number | null = null;
    if (i >= 20) {
      let upVol = 0;
      let downVol = 0;
      for (let k = i - 19; k <= i; k++) {
        const p = bars[k - 1].close;
        if (bars[k].close > p) upVol += bars[k].volume;
        else if (bars[k].close < p) downVol += bars[k].volume;
      }
      up_down_vol_ratio_20d = downVol > 0 ? upVol / downVol : null;
    }

    // OBV 20봉 기울기를 vol_ma20으로 정규화 (종목·시기 간 비교 가능하게)
    const rawSlope = regressionSlope(obv, i, 20);
    const obv_slope_20d =
      rawSlope != null && vol_ma20 != null && vol_ma20 > 0
        ? rawSlope / vol_ma20
        : null;

    return {
      ...b,
      vol_ma20,
      vol_ma50,
      volume_ratio_20d: vol_ma20 != null && vol_ma20 > 0 ? b.volume / vol_ma20 : null,
      volume_zscore_60d,
      dollar_volume: b.close * b.volume,
      close_change_pct,
      abs_close_change_pct: close_change_pct == null ? null : Math.abs(close_change_pct),
      close_position_in_range,
      range_pct: b.close > 0 ? (span / b.close) * 100 : 0,
      up_down_vol_ratio_20d,
      obv: obv[i],
      obv_slope_20d,
      atr14: atr[i],
      atr_ratio_20d,
    };
  });
}
