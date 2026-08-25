/**
 * 텔레그램 Bot API 전송.
 *
 * 준비물은 두 개뿐이다:
 *  - TELEGRAM_BOT_TOKEN: @BotFather 에서 /newbot 으로 발급
 *  - TELEGRAM_CHAT_ID:   내가 그 봇에게 아무 말이나 보낸 뒤 /api/alerts/chat-id 로 확인
 */

export class TelegramError extends Error {}

function botToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

function chatId(): string | null {
  return process.env.TELEGRAM_CHAT_ID?.trim() || null;
}

export function telegramStatus(): { botToken: boolean; chatId: boolean } {
  return { botToken: Boolean(botToken()), chatId: Boolean(chatId()) };
}

export function telegramReady(): boolean {
  const s = telegramStatus();
  return s.botToken && s.chatId;
}

/** api.telegram.org가 막힌 망에서 프록시를 끼울 수 있게 열어 둔다. 보통은 건드릴 일이 없다. */
function apiBase(): string {
  return (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
}

async function callBotApi(method: string, payload: unknown): Promise<unknown> {
  const token = botToken();
  if (!token) throw new TelegramError("TELEGRAM_BOT_TOKEN이 설정되지 않았습니다.");

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new TelegramError(`텔레그램에 연결하지 못했습니다: ${(e as Error).message}`);
  }

  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: unknown; description?: string }
    | null;

  if (!res.ok || !body?.ok) {
    // 토큰이 통째로 로그에 남지 않도록 텔레그램이 준 설명만 옮긴다.
    throw new TelegramError(body?.description ?? `텔레그램 API 오류 (HTTP ${res.status})`);
  }
  return body.result;
}

/** 알림 한 건 전송. 실패하면 TelegramError. */
export async function sendTelegram(text: string): Promise<void> {
  // 설정 순서대로(토큰 → 채팅 id) 짚어 줘야 다음에 뭘 해야 할지 알 수 있다.
  if (!botToken()) throw new TelegramError("TELEGRAM_BOT_TOKEN이 설정되지 않았습니다.");
  const to = chatId();
  if (!to) throw new TelegramError("TELEGRAM_CHAT_ID가 설정되지 않았습니다.");
  await callBotApi("sendMessage", {
    chat_id: to,
    text,
    disable_web_page_preview: true,
  });
}

/**
 * 봇에게 말을 건 채팅방의 chat_id 목록. 최초 설정 때 한 번 쓴다.
 * (getUpdates는 웹훅이 걸려 있지 않을 때만 동작한다 — 이 앱은 웹훅을 쓰지 않는다.)
 */
export async function recentChatIds(): Promise<{ id: string; name: string }[]> {
  const result = await callBotApi("getUpdates", { limit: 20 });
  const updates = (Array.isArray(result) ? result : []) as {
    message?: { chat?: { id?: number; title?: string; username?: string; first_name?: string } };
  }[];

  const seen = new Map<string, string>();
  for (const update of updates) {
    const chat = update?.message?.chat;
    if (!chat?.id) continue;
    const name = chat.title ?? chat.username ?? chat.first_name ?? "(이름 없음)";
    seen.set(String(chat.id), name);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}
