/**
 * 상승장 지표 배터리가 쓰는 표준 기술적 지표들.
 *
 * lib/indicators.ts 는 거래량 분석용 파생값만 만든다. 여기 있는 건
 * "보통 사람들이 차트에서 보는" 지표(RSI/MACD/볼린저/ADX/스토캐스틱/CCI/일목)다.
 * 전부 순수 함수이고, 값이 확정되지 않은 앞구간은 null을 돌려준다.
 *
 * 파라미터는 전부 관례적인 라운드 넘버로 고정한다. 최적값을 탐색하면
 * 사이클 표본이 서너 개뿐인 상황에서 노이즈를 맞추게 되기 때문이다.
 */

import type { Bar } from "@/types";

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI. 상승장 판정에서 제일 많이 보는 모멘텀 지표. */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export type MacdSeries = {
  macd: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
};

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  const n = closes.length;
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);

  const line: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (fastEma[i] != null && slowEma[i] != null) line[i] = fastEma[i]! - slowEma[i]!;
  }

  // 시그널선은 MACD가 정의된 구간에서만 EMA를 돌린다.
  const start = line.findIndex((v) => v != null);
  const signal: (number | null)[] = new Array(n).fill(null);
  const hist: (number | null)[] = new Array(n).fill(null);
  if (start >= 0) {
    const dense = line.slice(start).map((v) => v as number);
    const sig = ema(dense, signalPeriod);
    for (let i = 0; i < dense.length; i++) {
      const v = sig[i];
      if (v == null) continue;
      signal[start + i] = v;
      hist[start + i] = dense[i] - v;
    }
  }
  return { macd: line, signal, hist };
}

export type BollingerSeries = {
  mid: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
  /** (상단-하단)/중심. 스퀴즈 판정에 쓴다. */
  bandwidth: (number | null)[];
};

export function bollinger(closes: number[], period = 20, mult = 2): BollingerSeries {
  const n = closes.length;
  const mid = sma(closes, period);
  const upper: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  const bandwidth: (number | null)[] = new Array(n).fill(null);

  for (let i = period - 1; i < n; i++) {
    const m = mid[i];
    if (m == null) continue;
    let sq = 0;
    for (let k = i - period + 1; k <= i; k++) sq += (closes[k] - m) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    bandwidth[i] = m > 0 ? ((upper[i]! - lower[i]!) / m) * 100 : null;
  }
  return { mid, upper, lower, bandwidth };
}

export type AdxSeries = {
  adx: (number | null)[];
  plusDI: (number | null)[];
  minusDI: (number | null)[];
};

/** Wilder ADX/DI. 추세가 "시작됐는지"를 보는 표준 지표. */
export function adx(bars: Bar[], period = 14): AdxSeries {
  const n = bars.length;
  const out: AdxSeries = {
    adx: new Array(n).fill(null),
    plusDI: new Array(n).fill(null),
    minusDI: new Array(n).fill(null),
  };
  if (n < period * 2 + 1) return out;

  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    tr[i] = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    const up = b.high - p.high;
    const down = p.low - b.low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  let trS = 0;
  let plusS = 0;
  let minusS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    plusS += plusDM[i];
    minusS += minusDM[i];
  }

  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      plusS = plusS - plusS / period + plusDM[i];
      minusS = minusS - minusS / period + minusDM[i];
    }
    if (trS <= 0) continue;
    const pdi = (plusS / trS) * 100;
    const mdi = (minusS / trS) * 100;
    out.plusDI[i] = pdi;
    out.minusDI[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0;
  }

  // ADX = DX의 Wilder 평활. 첫 값은 단순평균.
  const firstDx = period;
  const adxStart = firstDx + period - 1;
  if (adxStart < n) {
    let sum = 0;
    let count = 0;
    for (let i = firstDx; i <= adxStart; i++) {
      if (dx[i] == null) continue;
      sum += dx[i]!;
      count++;
    }
    if (count > 0) {
      let prev = sum / count;
      out.adx[adxStart] = prev;
      for (let i = adxStart + 1; i < n; i++) {
        if (dx[i] == null) continue;
        prev = (prev * (period - 1) + dx[i]!) / period;
        out.adx[i] = prev;
      }
    }
  }
  return out;
}

export type StochSeries = { k: (number | null)[]; d: (number | null)[] };

export function stochastic(bars: Bar[], kPeriod = 14, kSmooth = 3, dPeriod = 3): StochSeries {
  const n = bars.length;
  const raw: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - kPeriod + 1; k <= i; k++) {
      hi = Math.max(hi, bars[k].high);
      lo = Math.min(lo, bars[k].low);
    }
    raw[i] = hi > lo ? ((bars[i].close - lo) / (hi - lo)) * 100 : 50;
  }
  const k = smoothNullable(raw, kSmooth);
  const d = smoothNullable(k, dPeriod);
  return { k, d };
}

export function cci(bars: Bar[], period = 20): (number | null)[] {
  const n = bars.length;
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const out: (number | null)[] = new Array(n).fill(null);
  const avg = sma(tp, period);
  for (let i = period - 1; i < n; i++) {
    const m = avg[i];
    if (m == null) continue;
    let dev = 0;
    for (let k = i - period + 1; k <= i; k++) dev += Math.abs(tp[k] - m);
    const md = dev / period;
    out[i] = md > 0 ? (tp[i] - m) / (0.015 * md) : 0;
  }
  return out;
}

export type IchimokuSeries = {
  conversion: (number | null)[];
  base: (number | null)[];
  /** 해당 봉 시점에 실제로 보이는 구름의 위/아래 경계 (26봉 선행 반영). */
  cloudTop: (number | null)[];
  cloudBottom: (number | null)[];
};

/**
 * 일목균형표. 선행스팬 A/B는 26봉 앞에 그려지므로, i번 봉 위에 보이는 구름은
 * i-26번 봉에서 계산된 값이다. 그래서 미래 정보를 쓰지 않는다.
 */
export function ichimoku(bars: Bar[], conv = 9, baseP = 26, spanB = 52, shift = 26): IchimokuSeries {
  const n = bars.length;
  const midpoint = (period: number): (number | null)[] => {
    const out: (number | null)[] = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - period + 1; k <= i; k++) {
        hi = Math.max(hi, bars[k].high);
        lo = Math.min(lo, bars[k].low);
      }
      out[i] = (hi + lo) / 2;
    }
    return out;
  };

  const conversion = midpoint(conv);
  const base = midpoint(baseP);
  const spanBRaw = midpoint(spanB);

  const cloudTop: (number | null)[] = new Array(n).fill(null);
  const cloudBottom: (number | null)[] = new Array(n).fill(null);
  for (let i = shift; i < n; i++) {
    const src = i - shift;
    const a = conversion[src] != null && base[src] != null ? (conversion[src]! + base[src]!) / 2 : null;
    const b = spanBRaw[src];
    if (a == null || b == null) continue;
    cloudTop[i] = Math.max(a, b);
    cloudBottom[i] = Math.min(a, b);
  }
  return { conversion, base, cloudTop, cloudBottom };
}

export function rollingMax(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let hi = -Infinity;
    for (let k = i - period + 1; k <= i; k++) hi = Math.max(hi, values[k]);
    out[i] = hi;
  }
  return out;
}

export function rollingMin(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let lo = Infinity;
    for (let k = i - period + 1; k <= i; k++) lo = Math.min(lo, values[k]);
    out[i] = lo;
  }
  return out;
}

/** 분위수 (0~1). 스퀴즈 판정용. */
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function smoothNullable(values: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let k = i - period + 1; k <= i; k++) {
      const v = values[k];
      if (v == null) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}
