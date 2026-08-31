import { json } from "@/lib/json-response";
import { alertsAvailable } from "@/lib/alerts/store";
import { listGradeWatches } from "@/lib/alerts/grade-store";
import { runGradeCheck } from "@/lib/alerts/grade-check";
import { telegramReady } from "@/lib/alerts/telegram";
import { normalizeTicker } from "@/lib/data/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 종목마다 20년치 일봉을 받아 지표 30개 + 조합 수십 개를 채점한다.
export const maxDuration = 60;

function guard(): Response | null {
  if (!alertsAvailable()) {
    return json({ error: "알림 저장소(KV)가 설정되지 않았습니다." }, { status: 503 });
  }
  if (!telegramReady()) {
    return json(
      { error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID가 설정되지 않았습니다." },
      { status: 503 },
    );
  }
  return null;
}

/** 크론용. 등록된 종목 전부를 돈다. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "권한이 없습니다." }, { status: 401 });
  }

  const blocked = guard();
  if (blocked) return blocked;

  const watches = await listGradeWatches();
  if (!watches.length) {
    return json({ checked: 0, sent: 0, notes: ["등록된 A등급 알림이 없습니다."] });
  }
  return json(await runGradeCheck(watches));
}

/**
 * 화면의 '지금 검사' 버튼용. 한 종목만 돈다.
 *
 * 크론을 하루 기다리지 않고 "정말 오는지" 확인할 수 있어야 한다. 다만 채점이 무거워서
 * 한 번에 한 종목으로 제한한다. 조건·중복 판정은 크론과 같은 코드(runGradeCheck)다.
 */
export async function POST(req: Request) {
  const blocked = guard();
  if (blocked) return blocked;

  let body: { ticker?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const ticker = normalizeTicker(typeof body.ticker === "string" ? body.ticker : "");
  const watches = await listGradeWatches();
  const target = watches.filter((w) => (ticker ? w.ticker === ticker : true)).slice(0, 1);
  if (!target.length) {
    return json({ error: "등록된 종목이 아닙니다." }, { status: 400 });
  }
  return json(await runGradeCheck(target));
}
