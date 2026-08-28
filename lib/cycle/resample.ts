/**
 * 일봉 → 주봉/월봉 리샘플링.
 *
 * 거래소마다 주봉 마감 요일이 다르고 소스가 주봉을 직접 주지 않는 경우도 많아서
 * 일봉에서 직접 만든다. 기준은 ISO 주(월요일 시작)와 달력 월.
 *
 * 미래 참조 방지가 핵심이다. 주봉 MACD 골든크로스는 그 주가 "마감된 뒤"에야 알 수 있다.
 * 그래서 projectToDaily는 각 일봉에 '직전에 마감된' 기간의 값을 붙인다.
 * 이 처리가 없으면 주중에 이미 그 주의 종가를 아는 셈이 되어 백테스트가 전부 부풀려진다.
 */

import type { Bar } from "@/types";

export type PeriodBars = {
  bars: Bar[];
  /** 일봉 i가 속한 기간의 인덱스. */
  periodOf: number[];
};

function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  // ISO 주: 목요일이 속한 해가 그 주의 해다.
  const day = (d.getUTCDay() + 6) % 7; // 월=0
  d.setUTCDate(d.getUTCDate() - day + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function aggregate(bars: Bar[], keyOf: (date: string) => string): PeriodBars {
  const out: Bar[] = [];
  const periodOf: number[] = new Array(bars.length).fill(-1);
  let currentKey: string | null = null;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const key = keyOf(b.date);
    if (key !== currentKey) {
      currentKey = key;
      out.push({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    } else {
      const agg = out[out.length - 1];
      agg.high = Math.max(agg.high, b.high);
      agg.low = Math.min(agg.low, b.low);
      agg.close = b.close;
      agg.volume += b.volume;
      // 기간 봉의 날짜는 마지막 거래일로 둔다 (그 기간이 마감된 날).
      agg.date = b.date;
    }
    periodOf[i] = out.length - 1;
  }
  return { bars: out, periodOf };
}

export function toWeekly(bars: Bar[]): PeriodBars {
  return aggregate(bars, isoWeekKey);
}

export function toMonthly(bars: Bar[]): PeriodBars {
  return aggregate(bars, monthKey);
}

/**
 * 기간 단위로 계산한 값을 일봉 타임라인에 되돌린다.
 *
 * 일봉 i에는 '직전에 완전히 마감된' 기간의 값만 붙인다. 진행 중인 주/월의 값은
 * 그 시점에 알 수 없으므로 쓰지 않는다.
 */
export function projectToDaily<T>(
  periodOf: number[],
  periodValues: (T | null)[],
  fallback: T | null = null,
): (T | null)[] {
  return periodOf.map((p) => {
    const prev = p - 1;
    if (prev < 0 || prev >= periodValues.length) return fallback;
    return periodValues[prev] ?? fallback;
  });
}
