import { NextResponse } from "next/server";
import { checkLatest, formatAlert, type SignalHit } from "@/lib/alerts/evaluate";
import { alertsAvailable, listWatches, markNotified, type Watch } from "@/lib/alerts/store";
import { TelegramError, sendTelegram, telegramReady } from "@/lib/alerts/telegram";
import { loadBars } from "@/lib/data";
import { enrich } from "@/lib/indicators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 종목마다 시세를 새로 받아온다. 폴백 체인까지 감안하면 기본 10초로는 모자란다.
export const maxDuration = 60;

/**
 * 매일 장 마감 뒤 도는 알림 점검 (vercel.json의 crons가 호출).
 *
 * 판정은 "가장 최근 봉"만 본다. 과거 신호를 몰아서 보내면 알림이 무의미해진다.
 * 같은 날 같은 신호는 lastNotifiedDate로 한 번만 나간다 — 크론이 두 번 돌거나
 * 수동으로 다시 호출해도 중복 발송되지 않는다.
 */
export async function GET(req: Request) {
  // Vercel Cron은 CRON_SECRET이 설정돼 있으면 Authorization 헤더를 붙여 준다.
  // 설정돼 있는데 헤더가 없으면 외부에서 들어온 호출이므로 막는다.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 401 });
  }

  if (!alertsAvailable()) {
    return NextResponse.json({ error: "알림 저장소(KV)가 설정되지 않았습니다." }, { status: 503 });
  }
  if (!telegramReady()) {
    return NextResponse.json(
      { error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  const watches = await listWatches();
  if (!watches.length) return NextResponse.json({ checked: 0, sent: 0, notes: ["등록된 알림이 없습니다."] });

  // 같은 종목의 여러 신호는 시세를 한 번만 받는다 (시세 API 호출 수 = 종목 수).
  const byTicker = new Map<string, Watch[]>();
  for (const w of watches) {
    const list = byTicker.get(w.ticker);
    if (list) list.push(w);
    else byTicker.set(w.ticker, [w]);
  }

  const notes: string[] = [];
  const marks: { id: string; date: string }[] = [];
  let sent = 0;

  for (const [ticker, group] of byTicker) {
    let enriched;
    try {
      // 오늘 봉이 들어있어야 하므로 캐시가 fresh여도 새로 받는다.
      const bars = await loadBars(ticker, { forceFresh: true });
      if (bars.length < 60) {
        notes.push(`${ticker}: 데이터 ${bars.length}일치뿐이라 건너뜀`);
        continue;
      }
      enriched = enrich(bars);
    } catch (e) {
      // 한 종목이 실패해도 나머지는 계속 본다.
      notes.push(`${ticker}: 시세를 받지 못함 (${(e as Error).message})`);
      continue;
    }

    const latestDate = enriched[enriched.length - 1].date;
    const fired: { watchId: string; hit: SignalHit }[] = [];
    let alreadySent = 0;
    for (const w of group) {
      if (w.lastNotifiedDate === latestDate) {
        alreadySent++; // 이 봉으로는 이미 알렸다
        continue;
      }
      const hit = checkLatest(enriched, w.signal);
      if (hit) fired.push({ watchId: w.id, hit });
    }

    if (!fired.length) {
      notes.push(
        alreadySent === group.length
          ? `${ticker}: ${latestDate} 이미 알림 보냄`
          : `${ticker}: ${latestDate} 신호 없음`,
      );
      continue;
    }

    const hits = fired.map((f) => f.hit);
    try {
      await sendTelegram(formatAlert(ticker, hits));
      sent += hits.length;
      // 표식은 전송에 성공한 뒤에만 남긴다. 실패하면 다음 실행에서 다시 시도한다.
      for (const f of fired) marks.push({ id: f.watchId, date: latestDate });
      notes.push(`${ticker}: ${hits.map((h) => h.label).join(", ")} 발송`);
    } catch (e) {
      const msg = e instanceof TelegramError ? e.message : (e as Error).message;
      notes.push(`${ticker}: 전송 실패 (${msg})`);
    }
  }

  await markNotified(marks);
  return NextResponse.json({ checked: byTicker.size, sent, notes });
}
