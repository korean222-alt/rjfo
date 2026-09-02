import { json } from "@/lib/json-response";
import { crossSiteDenied } from "@/lib/alerts/auth";
import { TelegramError, sendTelegram } from "@/lib/alerts/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 설정이 끝났는지 확인하는 테스트 발송. */
export async function POST(req: Request) {
  const offSite = crossSiteDenied(req);
  if (offSite) return offSite;

  try {
    await sendTelegram(
      "🔔 거래량 분석기 알림 테스트\n\n이 메시지가 보이면 설정이 끝난 겁니다.\n등록한 신호가 뜨는 날 장 마감 후에 알려드릴게요.",
    );
    return json({ ok: true });
  } catch (e) {
    if (e instanceof TelegramError) {
      return json({ error: e.message }, { status: 400 });
    }
    return json({ error: `전송 실패: ${(e as Error).message}` }, { status: 500 });
  }
}
