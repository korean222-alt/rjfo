import type { Bar } from "@/types";

/**
 * 일봉을 주봉·월봉으로 묶는다.
 *
 * 시세 소스는 전부 일봉만 준다. 주봉·월봉 지표를 보려면 여기서 직접 묶어야 한다.
 * 묶는 규칙은 거래소와 동일하다: 시가는 구간 첫 봉, 종가는 마지막 봉, 고가/저가는
 * 구간 전체의 최대/최소, 거래량은 합. 펀딩비는 구간 평균(코인만).
 */

export const TIMEFRAMES = ["1d", "1w", "1M"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  "1d": "일봉",
  "1w": "주봉",
  "1M": "월봉",
};

/** 봉 하나를 세는 단위 (지표 설명에 쓴다). */
export const TIMEFRAME_UNIT: Record<Timeframe, string> = {
  "1d": "일",
  "1w": "주",
  "1M": "개월",
};

export function isTimeframe(v: unknown): v is Timeframe {
  return typeof v === "string" && (TIMEFRAMES as readonly string[]).includes(v);
}

export function toTimeframe(v: unknown, fallback: Timeframe = "1d"): Timeframe {
  return isTimeframe(v) ? v : fallback;
}

/**
 * 그 날짜가 속한 봉의 시작일.
 *  - 주봉: 그 주 월요일 (거래소 주봉 기준)
 *  - 월봉: 그 달 1일
 *
 * 날짜만 다루므로 UTC로 계산한다. 로컬 타임존을 타면 자정 근처에서 하루가 밀린다.
 */
export function bucketStart(date: string, tf: Timeframe): string {
  if (tf === "1M") return `${date.slice(0, 7)}-01`;
  if (tf === "1d") return date;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const backToMonday = (d.getUTCDay() + 6) % 7; // 일=0 → 6, 월=1 → 0
  d.setUTCDate(d.getUTCDate() - backToMonday);
  return d.toISOString().slice(0, 10);
}

/** 집계된 봉. date는 구간 시작일, periodEnd는 그 구간의 마지막 거래일. */
export type PeriodBar = Bar & {
  /** 구간의 마지막 거래일 (= 이 봉이 반영하는 최신 시세 날짜) */
  periodEnd: string;
  /** 이 봉에 들어간 일봉 개수 */
  dayCount: number;
};

/**
 * 오름차순 일봉을 주봉/월봉으로 묶는다. tf가 "1d"면 그대로 통과시킨다.
 * 마지막 봉은 아직 진행 중일 수 있다 (dayCount로 확인 가능).
 */
export function aggregateBars(bars: Bar[], tf: Timeframe): PeriodBar[] {
  if (tf === "1d") {
    return bars.map((b) => ({ ...b, periodEnd: b.date, dayCount: 1 }));
  }

  const out: PeriodBar[] = [];
  let cur: PeriodBar | null = null;
  let fundingSum = 0;
  let fundingCount = 0;

  for (const b of bars) {
    const start = bucketStart(b.date, tf);
    if (!cur || cur.date !== start) {
      if (cur) out.push(cur);
      cur = {
        date: start,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        funding: null,
        periodEnd: b.date,
        dayCount: 1,
      };
      fundingSum = 0;
      fundingCount = 0;
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.periodEnd = b.date;
      cur.dayCount += 1;
    }

    if (b.funding != null && Number.isFinite(b.funding)) {
      fundingSum += b.funding;
      fundingCount += 1;
    }
    cur.funding = fundingCount > 0 ? fundingSum / fundingCount : null;
  }

  if (cur) out.push(cur);
  return out;
}
