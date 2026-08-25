import { json } from "@/lib/json-response";
import { TelegramError, recentChatIds } from "@/lib/alerts/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 최초 설정용 — 봇에게 말을 건 채팅방의 chat_id를 알려준다.
 * 여기서 나온 값을 환경변수 TELEGRAM_CHAT_ID에 넣으면 된다.
 */
export async function GET() {
  try {
    const chats = await recentChatIds();
    return json({
      chats,
      hint: chats.length
        ? "이 중 본인 채팅의 id를 환경변수 TELEGRAM_CHAT_ID에 넣으세요."
        : "텔레그램에서 봇을 찾아 아무 메시지나 한 번 보낸 뒤 다시 열어 주세요.",
    });
  } catch (e) {
    if (e instanceof TelegramError) {
      return json({ error: e.message }, { status: 400 });
    }
    return json({ error: (e as Error).message }, { status: 500 });
  }
}
