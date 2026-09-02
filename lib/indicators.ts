import type { Bar, EnrichedBar } from "@/types";

export function smaValue(values: number[], i: number, n: number): number | null {
  if (n < 1 || i < n - 1) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) sum += values[k];
  return sum / n;
}

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

export function enrich(bars: Bar[]): EnrichedBar[] {
  const n = bars.length;
  const volumes = bars.map((b) => b.volume);

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
    const vol_ma20 = smaValue(volumes, i, 20);
    const vol_ma50 = smaValue(volumes, i, 50);
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

    const span = b.high - b.low;
    const close_position_in_range = span > 0 ? (b.close - b.low) / span : 0.5;

    let up_down_vol_ratio_20d: number | null = null;
    if (i >= 20) {
      let upVol = 0;
      let downVol = 0;
      for (let k = i - 19; k <= i; k++) {
        const p = bars[k - 1].close;
        if (bars[k].close > p) upVol += bars[k].volume;
        else if (bars[k].close < p) downVol += bars[k].volume;
      }
      // 하락일 거래량이 0이면(20일 내내 오르기만 한 구간) 비율은 무한대다.
      // 이걸 null로 두면 매수 우위가 가장 강한 자리에서 신호가 워밍업처럼 빠지고,
      // 첫 음봉이 나온 다음에야 켜진다. 값을 못 재는 건 위아래 둘 다 없을 때뿐이다.
      up_down_vol_ratio_20d =
        downVol > 0 ? upVol / downVol : upVol > 0 ? Number.POSITIVE_INFINITY : null;
    }

    const rawSlope = regressionSlope(obv, i, 20);
    const obv_slope_20d =
      rawSlope != null && vol_ma20 != null && vol_ma20 > 0
        ? rawSlope / vol_ma20
        : null;

    const funding_pct = b.funding != null && Number.isFinite(b.funding) ? b.funding * 100 : null;
    let funding_zscore_60d: number | null = null;
    if (i >= 59) {
      const window: number[] = [];
      let ok = true;
      for (let k = i - 59; k <= i; k++) {
        const f = bars[k].funding;
        if (f == null || !Number.isFinite(f)) {
          ok = false;
          break;
        }
        window.push(f * 100);
      }
      if (ok) {
        const z = meanStd(window, window.length - 1, 60);
        if (z && z.std > 0) funding_zscore_60d = (window[window.length - 1] - z.mean) / z.std;
      }
    }
    const prevFunding = i > 0 ? bars[i - 1].funding : null;
    const funding_flip =
      b.funding != null &&
      prevFunding != null &&
      Math.abs(b.funding) > 1e-8 &&
      Math.abs(prevFunding) > 1e-8 &&
      Math.sign(b.funding) !== Math.sign(prevFunding)
        ? 1
        : b.funding != null
          ? 0
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
      funding_pct,
      funding_zscore_60d,
      funding_z_abs: funding_zscore_60d == null ? null : Math.abs(funding_zscore_60d),
      funding_abs: funding_pct == null ? null : Math.abs(funding_pct),
      funding_flip,
    };
  });
}
