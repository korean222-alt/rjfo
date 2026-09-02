/**
 * Vercel KV(Upstash Redis) REST 클라이언트 — 필요한 만큼만.
 *
 * env는 반드시 호출 시점에 읽는다. 모듈 최상위에서 읽으면 Next가 빌드 타임에
 * 값을 인라인해 버려서 배포 환경변수가 무시된다.
 */

const TIMEOUT_MS = 3_000;

/**
 * URL·토큰 환경변수를 이름으로 찾아낸다.
 *
 * 왜 이렇게까지 하는가: Upstash를 Vercel Marketplace로 붙일 때 사용자가 접두사를 넣으면
 * 실제 이름이 통째로 바뀐다. 이 프로젝트에선 한 번 접두사가 "KV_REST_API_URL"로 잘못
 * 들어가 값이 KV_REST_API_URL_KV_REST_API_URL 밑에 있었다. 통합 종류에 따라
 * UPSTASH_REDIS_REST_URL / REDIS_REST_URL 로 들어오기도 한다.
 *
 * 이름을 하드코딩해 두면 그때마다 "저장소가 없습니다"가 뜨고, 사용자는 이미 연결해 둔
 * 스토어를 다시 연결하려 든다. 그래서 정해진 이름 몇 개를 먼저 보고, 없으면
 * 이름 규칙(...REST_API_URL / ...REDIS_REST_URL)에 맞는 변수를 찾아 짝을 맞춘다.
 */
const URL_PATTERN = /(?:KV_REST_API_URL|REDIS_REST_URL)$/;
const TOKEN_PATTERN = /(?:KV_REST_API_TOKEN|REDIS_REST_TOKEN)$/;

function pickUrlKey(): string | null {
  for (const name of ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]) {
    if (process.env[name]?.trim()) return name;
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (URL_PATTERN.test(name) && value?.trim()) return name;
  }
  return null;
}

function pickTokenKey(urlKey: string): string | null {
  // 같은 접두사끼리 짝지어야 한다. 스토어가 두 개 붙어 있을 때 URL과 토큰이
  // 서로 다른 스토어의 것이면 요청이 통째로 401로 죽는다.
  const sibling = urlKey.replace(/URL$/, "TOKEN");
  if (process.env[sibling]?.trim()) return sibling;
  for (const name of ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"]) {
    if (process.env[name]?.trim()) return name;
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (TOKEN_PATTERN.test(name) && value?.trim()) return name;
  }
  return null;
}

function config() {
  const urlKey = pickUrlKey();
  if (!urlKey) return null;
  const tokenKey = pickTokenKey(urlKey);
  if (!tokenKey) return null;
  return {
    url: process.env[urlKey]!.trim().replace(/\/+$/, ""),
    token: process.env[tokenKey]!.trim(),
    urlKey,
    tokenKey,
  };
}

/**
 * 어떤 환경변수로 붙었는지. 화면에 "저장소 없음"만 띄우면 사용자가 확인할 방법이 없어서,
 * 이름(값은 절대 아니다)을 진단에 그대로 내보낸다.
 */
export function kvSource(): { urlKey: string; tokenKey: string } | null {
  const kv = config();
  return kv ? { urlKey: kv.urlKey, tokenKey: kv.tokenKey } : null;
}

export function kvConfigured(): boolean {
  return config() !== null;
}

/** KV에 못 닿았다. '키가 없다'와 반드시 구분해야 하는 상황. */
export class KvUnavailableError extends Error {}

/**
 * 키를 읽는다. 값이 없으면 null.
 *
 * 장애(타임아웃·5xx·네트워크)는 null이 아니라 예외로 던진다. 둘을 같은 null로
 * 뭉개면 호출자가 "키가 없다"로 읽고, 워치리스트처럼 읽고-고쳐-쓰는 값은
 * 빈 목록으로 저장되어 등록해 둔 알림이 통째로 날아간다. KV가 3초 죽은 것과
 * 사용자가 아무것도 등록하지 않은 것은 다른 사건이다.
 */
export async function kvGet(key: string): Promise<string | null> {
  const kv = config();
  if (!kv) return null;
  let res: Response;
  try {
    res = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${kv.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new KvUnavailableError(`저장소에 연결하지 못했습니다: ${(e as Error).message}`);
  }
  if (!res.ok) throw new KvUnavailableError(`저장소 오류 (HTTP ${res.status}).`);
  try {
    const body = (await res.json()) as { result: string | null };
    return body.result ?? null;
  } catch (e) {
    throw new KvUnavailableError(`저장소 응답을 읽지 못했습니다: ${(e as Error).message}`);
  }
}

/**
 * 캐시처럼 '없으면 그냥 다시 받으면 되는' 값 전용. 장애도 null로 흘린다.
 * 읽고-고쳐-쓰는 값에는 절대 쓰지 말 것 (위 kvGet 주석 참고).
 */
export async function kvGetOrNull(key: string): Promise<string | null> {
  try {
    return await kvGet(key);
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
