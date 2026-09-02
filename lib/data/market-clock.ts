/**
 * 마지막 일봉이 아직 '진행 중'인지.
 *
 * 왜 필요한가: 채점과 알림은 종가로 판정한다. 장이 안 끝난 날의 봉을 그대로 넣으면
 * 오전 11시의 값으로 "지금 켜짐"이 나가고, 그날 종가가 뒤집히면 없던 신호를 보낸 셈이 된다.
 *
 * 시장마다 하루가 끝나는 시각이 다르다:
 *   코인   — UTC 자정. 그래서 UTC 오늘 날짜의 봉은 항상 진행 중이다.
 *   KRX    — 15:30 KST (종가 단일가까지 15:20~15:30).
 *   미국   — 16:00 ET.
 * 소스가 값을 확정해 넣는 데 걸리는 시간까지 감안해 여유를 조금 준다.
 *
 * 시각은 Intl로 그 시장의 현지 시간을 직접 읽는다. 서버 타임존(Vercel은 UTC)에
 * 기대면 서머타임에서 한 시간씩 틀린다.
 */

import { isCryptoTicker } from "./provider";
import { isKoreanTicker } from "./naver";

type Market = { tz: string; closeMinutes: number };

/** 마감 + 여유. 소스가 종가를 반영할 시간을 준다. */
const GRACE_MINUTES = 10;

const KRX: Market = { tz: "Asia/Seoul", closeMinutes: 15 * 60 + 30 };
const US: Market = { tz: "America/New_York", closeMinutes: 16 * 60 };

/** 그 타임존에서의 오늘 날짜(YYYY-MM-DD)와 자정부터의 분. */
function localNow(tz: string, now: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // hour12:false는 자정을 "24"로 주는 구현이 있다.
  const hour = Number(get("hour")) % 24;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

/**
 * 마지막 봉이 아직 마감되지 않았는가.
 * 날짜가 그 시장의 '오늘'이고 마감 시각(+여유)을 아직 안 지났으면 진행 중이다.
 */
export function isIncompleteBar(ticker: string, date: string, now: Date = new Date()): boolean {
  if (isCryptoTicker(ticker)) {
    // 코인은 24시간 돌아서 UTC 오늘 봉은 무조건 진행 중이다.
    return date === now.toISOString().slice(0, 10);
  }
  const market = isKoreanTicker(ticker) ? KRX : US;
  const local = localNow(market.tz, now);
  return date === local.date && local.minutes < market.closeMinutes + GRACE_MINUTES;
}

/**
 * 진행 중인 마지막 봉을 떼어낸다. 뗄 게 없으면 원본 그대로 (새 배열을 만들지 않는다).
 * 봉이 하나뿐이면 떼지 않는다 — 빈 배열을 돌려주면 호출자가 전부 무너진다.
 */
export function dropIncompleteBar<T extends { date: string }>(
  ticker: string,
  bars: T[],
  now: Date = new Date(),
): T[] {
  if (bars.length < 2) return bars;
  return isIncompleteBar(ticker, bars[bars.length - 1].date, now) ? bars.slice(0, -1) : bars;
}
