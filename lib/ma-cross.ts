import type { Bar } from "@/types";

export type MaCrossType = "golden" | "dead";

export type MaCross = {
  date: string;
  type: MaCrossType;
  close: number;
  /** 교차 시점의 단기/장기 이동평균 값 */
  fastValue: number;
  slowValue: number;
  /** 교차일 종가 대비 이후 20거래일 종가 수익률(%). 창이 모자라면 null. */
  forwardReturn20d: number | null;
};

export const MA_PERIOD_MIN = 2;
export const MA_PERIOD_MAX = 400;

/** 기간 입력을 정수로 다듬고 허용 범위로 자른다. */
export function clampPeriod(value: number): number {
  if (!isFinite(value)) return MA_PERIOD_MIN;
  return Math.min(MA_PERIOD_MAX, Math.max(MA_PERIOD_MIN, Math.round(value)));
}

/**
 * 단순 이동평균 배열. 구간이 모자라는 앞쪽은 null.
 * 롤링 합으로 O(n) — 기간을 바꿔가며 다시 그려도 부담이 없다.
 */
export function movingAverage(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period < 1 || n < period) return out;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * 골든크로스 / 데드크로스 지점.
 *
 * 두 선의 차(fast - slow)가 부호를 바꾸는 봉을 교차일로 본다.
 *  - 골든크로스: 직전 봉에서 단기선이 장기선 이하였는데 이번 봉에서 위로 올라섬
 *  - 데드크로스: 그 반대
 *
 * 두 선이 정확히 겹친 봉(diff === 0)은 교차로 세지 않는다. 다음 봉에서 실제로
 * 뚫고 올라가야 신호다 — 맞닿기만 하고 되돌아가는 경우를 교차로 세면 신호가 두 배가 된다.
 */
export function detectMaCrosses(
  bars: Pick<Bar, "date" | "close">[],
  fastPeriod: number,
  slowPeriod: number,
): MaCross[] {
  const fast = clampPeriod(fastPeriod);
  const slow = clampPeriod(slowPeriod);
  if (fast >= slow) return []; // 단기 ≥ 장기면 교차 개념이 성립하지 않는다

  const closes = bars.map((b) => b.close);
  const fastMa = movingAverage(closes, fast);
  const slowMa = movingAverage(closes, slow);

  const out: MaCross[] = [];
  let prevDiff: number | null = null;

  for (let i = 0; i < bars.length; i++) {
    const f = fastMa[i];
    const s = slowMa[i];
    if (f == null || s == null) continue;

    const diff = f - s;
    if (prevDiff != null && diff !== 0) {
      const type: MaCrossType | null =
        prevDiff <= 0 && diff > 0 ? "golden" : prevDiff >= 0 && diff < 0 ? "dead" : null;
      if (type) {
        const j = i + 20;
        const base = bars[i].close;
        out.push({
          date: bars[i].date,
          type,
          close: base,
          fastValue: f,
          slowValue: s,
          forwardReturn20d:
            j < bars.length && base > 0 ? ((bars[j].close - base) / base) * 100 : null,
        });
      }
    }
    // diff === 0(두 선이 겹친 봉)이면 직전 부호를 그대로 들고 간다.
    if (diff !== 0) prevDiff = diff;
    else if (prevDiff == null) prevDiff = 0;
  }
  return out;
}

/** 차트용 이동평균 선 두 개. 값이 없는 구간은 빼고 준다. */
export function maLines(
  bars: Pick<Bar, "date" | "close">[],
  fastPeriod: number,
  slowPeriod: number,
): { fast: { date: string; value: number }[]; slow: { date: string; value: number }[] } {
  const closes = bars.map((b) => b.close);
  const pick = (period: number) =>
    movingAverage(closes, clampPeriod(period)).flatMap((v, i) =>
      v == null ? [] : [{ date: bars[i].date, value: v }],
    );
  return { fast: pick(fastPeriod), slow: pick(slowPeriod) };
}
