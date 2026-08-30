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

/** 차트에서 고르는 봉. 채점(analyzeCycle)은 항상 일봉이고, 이 값은 보기만 바꾼다. */
export const CHART_TFS = ["1d", "1w", "1M"] as const;
export type ChartTf = (typeof CHART_TFS)[number];

export const CHART_TF_LABEL: Record<ChartTf, string> = {
  "1d": "일봉",
  "1w": "주봉",
  "1M": "월봉",
};

export const CHART_TF_UNIT: Record<ChartTf, string> = {
  "1d": "일",
  "1w": "주",
  "1M": "개월",
};

export const CHART_TF_TV: Record<ChartTf, "D" | "W" | "M"> = {
  "1d": "D",
  "1w": "W",
  "1M": "M",
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

/** 차트에 그릴 봉. 일봉은 그대로, 주/월은 묶는다. */
export function barsForView(bars: Bar[], tf: ChartTf): Bar[] {
  if (tf === "1d") return bars;
  return (tf === "1w" ? toWeekly(bars) : toMonthly(bars)).bars;
}

/**
 * 일봉 날짜(사이클 바닥, 신호일)를 지금 보고 있는 봉의 날짜로 붙인다.
 * 주봉/월봉 차트는 봉 날짜가 '그 기간의 마지막 거래일'이라, 일봉 날짜를 그대로
 * 넘기면 마커가 안 찍힌다.
 */
export function snapDatesToView(dates: string[], daily: Bar[], tf: ChartTf): string[] {
  if (tf === "1d" || !dates.length || !daily.length) return dates;
  const { bars, periodOf } = tf === "1w" ? toWeekly(daily) : toMonthly(daily);
  const idx = new Map(daily.map((b, i) => [b.date, i]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of dates) {
    const i = idx.get(d);
    if (i == null) continue;
    const date = bars[periodOf[i]]?.date;
    if (!date || seen.has(date)) continue;
    seen.add(date);
    out.push(date);
  }
  return out;
}

/**
 * 기간 단위로 계산한 값을 일봉 타임라인에 되돌린다.
 *
 * 일봉 i에는 '그 시점에 이미 알 수 있는' 기간의 값만 붙인다. 주 중간이면 직전 주,
 * 그 주의 마지막 거래일이면 그 주 자신이다. 주봉 종가는 그날 종가와 같으므로
 * 마감일 당일에 그 주의 값을 쓰는 건 미래를 보는 게 아니다.
 *
 * 마감일까지 직전 주 값을 쓰면 화면이 최대 2주 뒤처진다. 차트에는 이미 30주선
 * 아래로 내려온 게 보이는데 "30주선 위 = 켜짐"이라고 뜨는 게 그 증상이었다.
 *
 * 데이터의 마지막 봉은 그 주가 끝났는지 알 수 없지만, 진행 중인 주를 지금 종가로
 * 마감한 셈 치고 쓴다. 차트가 그리는 값과 같아지고, '지금 켜짐/꺼짐'이 눈에 보이는
 * 것과 일치한다.
 */
export function projectToDaily<T>(
  periodOf: number[],
  periodValues: (T | null)[],
  fallback: T | null = null,
): (T | null)[] {
  const last = periodOf.length - 1;
  return periodOf.map((p, i) => {
    const closed = i === last || periodOf[i + 1] !== p;
    const src = closed ? p : p - 1;
    if (src < 0 || src >= periodValues.length) return fallback;
    return periodValues[src] ?? fallback;
  });
}
