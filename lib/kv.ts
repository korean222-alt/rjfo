/**
 * Vercel KV(Upstash Redis) REST 클라이언트 — 필요한 만큼만.
 *
 * env는 반드시 호출 시점에 읽는다. 모듈 최상위에서 읽으면 Next가 빌드 타임에
 * 값을 인라인해 버려서 배포 환경변수가 무시된다.
 */

const TIMEOUT_MS = 3_000;

function config() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export function kvConfigured(): boolean {
  return config() !== null;
}

/** 값이 없거나 KV가 없으면 null. KV 장애는 예외 대신 null로 흘린다. */
export async function kvGet(key: string): Promise<string | null> {
  const kv = config();
  if (!kv) return null;
  try {
    const res = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${kv.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result: string | null };
    return body.result ?? null;
  } catch {
    return null;
  }
}

/**
 * 저장 성공 여부를 반환한다.
 * 캐시 쓰기는 실패해도 무시할 수 있지만, 알림 워치리스트는 실패를 사용자에게 알려야 하므로
 * 삼키지 않고 boolean으로 돌려준다.
 */
export async function kvSet(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
  const kv = config();
  if (!kv) return false;
  const query = ttlSeconds ? `?EX=${ttlSeconds}` : "";
  try {
    const res = await fetch(`${kv.url}/set/${encodeURIComponent(key)}${query}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kv.token}`,
        "Content-Type": "application/json",
      },
      body: value,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
