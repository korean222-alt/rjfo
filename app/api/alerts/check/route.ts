import { json } from "@/lib/json-response";
import { cronDenied } from "@/lib/alerts/auth";
import { checkLatest, formatAlert, type SignalHit } from "@/lib/alerts/evaluate";
import {
  AlertStoreError,
  alertsAvailable,
  listWatches,
  markNotified,
  type Watch,
} from "@/lib/alerts/store";
import { TelegramError, sendTelegram, telegramReady } from "@/lib/alerts/telegram";
import { loadBars } from "@/lib/data";
import { attachFunding } from "@/lib/data/funding";
import { enrich } from "@/lib/indicators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const denied = cronDenied(req);
  if (denied) return denied;

  if (!alertsAvailable()) {
    return json({ error: "알림 저장소(KV)가 설정되지 않았습니다." }, { status: 503 });
  }
  if (!telegramReady()) {
    return json(
      { error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  // 저장소를 못 읽었으면 여기서 멈춘다. 계속 진행하면 markNotified가 빈 목록을 덮어쓴다.
  let watches: Watch[];
  try {
    watches = await listWatches();
  } catch (e) {
    const msg = e instanceof AlertStoreError ? e.message : (e as Error).message;
    return json({ error: msg }, { status: 503 });
  }
  if (!watches.length) return json({ checked: 0, sent: 0, notes: ["등록된 알림이 없습니다."] });

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
      const bars = await attachFunding(ticker, await loadBars(ticker, { forceFresh: true }));
      if (bars.length < 60) {
        notes.push(`${ticker}: 데이터 ${bars.length}일치뿐이라 건너뜀`);
        continue;
      }
      enriched = enrich(bars);
    } catch (e) {
      notes.push(`${ticker}: 시세를 받지 못함 (${(e as Error).message})`);
      continue;
    }

    const latestDate = enriched[enriched.length - 1].date;
    const fired: { watchId: string; hit: SignalHit }[] = [];
    let alreadySent = 0;
    for (const w of group) {
      if (w.lastNotifiedDate === latestDate) {
        alreadySent++;
        continue;
      }
      const hit = checkLatest(enriched, w.signal, w.params, ticker);
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
      for (const f of fired) marks.push({ id: f.watchId, date: latestDate });
      notes.push(`${ticker}: ${hits.map((h) => h.label).join(", ")} 발송`);
    } catch (e) {
      const msg = e instanceof TelegramError ? e.message : (e as Error).message;
      notes.push(`${ticker}: 전송 실패 (${msg})`);
    }
  }

  await markNotified(marks);
  return json({ checked: byTicker.size, sent, notes });
}
