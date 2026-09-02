import { MAX_YEARS, loadBars } from "@/lib/data";
import { attachFunding } from "@/lib/data/funding";
import { dropIncompleteBar } from "@/lib/data/market-clock";
import { enrich } from "@/lib/indicators";
import { analyzeCycle } from "@/lib/cycle";
import { TelegramError, sendTelegram } from "./telegram";
import { findGradeHits, formatGradeAlert, type GradeHit } from "./grade-alert";
import { markGradeNotified, type GradeWatch } from "./grade-store";

/**
 * A등급 알림 한 바퀴.
 *
 * 크론(하루 한 번)과 화면의 '지금 검사' 버튼이 같은 코드를 쓴다. 두 경로가 조건을
 * 따로 구현하면 "크론은 보냈는데 버튼은 안 보낸다" 같은 차이가 생긴다.
 */

/** 사이클 하나라도 나오려면 이만큼은 필요하다 (app/api/cycle/route.ts와 같은 기준). */
const MIN_BARS = 300;

export type GradeCheckResult = {
  checked: number;
  sent: number;
  notes: string[];
  /** 종목별로 이번에 알린 신호. 화면에서 결과를 보여줄 때 쓴다. */
  hits: { ticker: string; hits: GradeHit[] }[];
};

export async function runGradeCheck(watches: GradeWatch[]): Promise<GradeCheckResult> {
  const notes: string[] = [];
  const hitsByTicker: { ticker: string; hits: GradeHit[] }[] = [];
  const marks: { ticker: string; keys: string[]; date: string }[] = [];
  let sent = 0;

  for (const watch of watches) {
    const ticker = watch.ticker;
    try {
      const raw = await loadBars(ticker, { years: MAX_YEARS, forceFresh: true });
      // 아직 안 끝난 오늘 봉으로 채점하면 장중 값으로 A등급 알림이 나간다.
      // 거래량 알림(checkLatest)과 같은 기준을 쓴다.
      const bars = dropIncompleteBar(ticker, await attachFunding(ticker, raw));
      if (bars.length < MIN_BARS) {
        notes.push(`${ticker}: 일봉 ${bars.length}개뿐이라 사이클 채점을 못 함`);
        continue;
      }

      const report = analyzeCycle(ticker, enrich(bars));
      const hits = findGradeHits(report, watch.notified ?? {});
      if (!hits.length) {
        const aCount = [...report.signals, ...report.combos].filter((s) => s.grade === "A").length;
        notes.push(
          aCount
            ? `${ticker}: ${report.periodEnd} A등급 ${aCount}개는 있지만 새로 켜진 건 없음`
            : `${ticker}: ${report.periodEnd} A등급 신호 없음`,
        );
        continue;
      }

      try {
        await sendTelegram(formatGradeAlert(ticker, report, hits));
        sent += hits.length;
        hitsByTicker.push({ ticker, hits });
        marks.push({
          ticker,
          keys: hits.map((h) => h.dedupeKey),
          date: report.periodEnd,
        });
        notes.push(`${ticker}: ${hits.map((h) => h.label).join(", ")} 발송`);
      } catch (e) {
        const msg = e instanceof TelegramError ? e.message : (e as Error).message;
        notes.push(`${ticker}: 전송 실패 (${msg})`);
      }
    } catch (e) {
      notes.push(`${ticker}: 시세를 받지 못함 (${(e as Error).message})`);
    }
  }

  // 전송에 성공한 것만 '보냈다'고 기록한다. 실패한 신호는 다음 회차에 다시 시도된다.
  await markGradeNotified(marks);

  return { checked: watches.length, sent, notes, hits: hitsByTicker };
}
