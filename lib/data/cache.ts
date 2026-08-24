import type { Bar } from "@/types";

const TTL_SECONDS = 12 * 60 * 60; // 12시간

type Entry = { bars: Bar[]; expiresAt: number };

// KV가 없을 때의 폴백. 람다 인스턴스 단위라 완벽하진 않지만 rate limit 완화에는 충분하다.
const memory = new Map<string, Entry>();

function kvConfig() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

function keyFor(ticker: string): string {
  return `ohlcv:${ticker}`;
}

export async function getCachedBars(ticker: string): Promise<Bar[] | null> {
  const key = keyFor(ticker);
  const kv = kvConfig();

  if (kv) {
    try {
      const res = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${kv.token}` },
        cache: "no-store",
      });
      if (res.ok) {
        const body = (await res.json()) as { result: string | null };
        if (body.result) return JSON.parse(body.result) as Bar[];
      }
    } catch {
      // KV 장애는 치명적이지 않다. 메모리 캐시로 폴백.
    }
  }

  const hit = memory.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.bars;
  if (hit) memory.delete(key);
  return null;
}

export async function setCachedBars(ticker: string, bars: Bar[]): Promise<void> {
  const key = keyFor(ticker);
  memory.set(key, { bars, expiresAt: Date.now() + TTL_SECONDS * 1000 });

  const kv = kvConfig();
  if (!kv) return;
  try {
    await fetch(`${kv.url}/set/${encodeURIComponent(key)}?EX=${TTL_SECONDS}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kv.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bars),
    });
  } catch {
    // 캐시 쓰기 실패는 무시 (다음 요청에서 다시 시도).
  }
}
