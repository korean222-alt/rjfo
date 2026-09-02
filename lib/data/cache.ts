import { kvGetOrNull, kvSet } from "@/lib/kv";
import type { Bar } from "@/types";
import { isCryptoTicker } from "./provider";

/**
 * 일봉 캐시.
 *
 * 두 겹이다:
 *  - Vercel KV (KV_REST_API_URL/TOKEN이 있을 때). 인스턴스 간 공유되므로 rate limit 방어에 제일 효과적.
 *  - 람다 인스턴스 메모리. KV가 없을 때의 폴백. 인스턴스 단위라 완벽하진 않지만 없는 것보단 훨씬 낫다.
 *
 * FRESH_SECONDS가 지나도 STALE_SECONDS까지는 버리지 않는다.
 * 외부 시세 API가 429로 막혔을 때 "에러 화면" 대신 "조금 오래된 데이터"를 주기 위해서다.
 */

const FRESH_SECONDS = 12 * 60 * 60; // 12시간: 이 안이면 그냥 쓴다
/**
 * 코인은 더 짧게 본다.
 *
 * 코인 일봉은 UTC 자정에 마감된다. 12시간을 그대로 쓰면 마감 직전에 담긴 캐시가
 * 다음 날 정오까지 살아 있어서, 이미 끝난 어제 봉이 빠진 채로 "지금 켜짐"을 판정한다.
 * 주식은 하루 한 번만 갱신되므로 12시간이면 충분하다.
 */
const CRYPTO_FRESH_SECONDS = 3 * 60 * 60;
const STALE_SECONDS = 7 * 24 * 60 * 60; // 7일: 외부 API가 죽었을 때만 쓰는 비상용

type Envelope = { v: 1; savedAt: number; bars: Bar[] };

export type CacheHit = { bars: Bar[]; fresh: boolean };

const memory = new Map<string, Envelope>();

/** 테스트용 — 메모리 캐시 비우기. */
export function __clearMemoryCache(): void {
  memory.clear();
}

/** 테스트용 — 저장 시각을 앞당겨 stale 상태를 만든다. */
export function __setSavedAtForTest(ticker: string, savedAt: number, years?: number): void {
  const env = memory.get(keyFor(ticker, years));
  if (env) env.savedAt = savedAt;
}

/**
 * 받아오는 구간 자체가 달라지면 올려서 옛 캐시를 버린다.
 * v2: 코인 장기 히스토리를 Bitstamp로 앞까지 채우기 시작 (BTC가 2018년부터 시작하던 문제).
 */
const LONG_SCHEMA = "v2";

/**
 * 기간이 다르면 다른 캐시다. 5년치 캐시를 20년 요청에 돌려주면
 * 사이클 분석이 조용히 짧은 데이터로 돌아간다.
 */
function keyFor(ticker: string, years?: number): string {
  return years == null ? `ohlcv:${ticker}` : `ohlcv:${ticker}:${years}y:${LONG_SCHEMA}`;
}

function toHit(env: Envelope | null, freshSeconds: number): CacheHit | null {
  if (!env || !Array.isArray(env.bars) || !env.bars.length) return null;
  const ageSec = (Date.now() - env.savedAt) / 1000;
  if (ageSec > STALE_SECONDS) return null;
  return { bars: env.bars, fresh: ageSec <= freshSeconds };
}

/** 저장된 형태가 예전 버전(순수 배열)일 수도 있어서 둘 다 받아준다. */
function parseStored(raw: string): Envelope | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return { v: 1, savedAt: Date.now(), bars: parsed as Bar[] };
    const env = parsed as Envelope;
    if (env && Array.isArray(env.bars) && typeof env.savedAt === "number") return env;
    return null;
  } catch {
    return null;
  }
}

export async function getCachedBars(ticker: string, years?: number): Promise<CacheHit | null> {
  const key = keyFor(ticker, years);
  const freshSeconds = isCryptoTicker(ticker) ? CRYPTO_FRESH_SECONDS : FRESH_SECONDS;

  // KV 장애는 치명적이지 않다 (kvGetOrNull이 null을 준다). 메모리 캐시로 폴백.
  const raw = await kvGetOrNull(key);
  if (raw) {
    const hit = toHit(parseStored(raw), freshSeconds);
    if (hit) return hit;
  }

  const hit = toHit(memory.get(key) ?? null, freshSeconds);
  if (!hit) memory.delete(key);
  return hit;
}

export async function setCachedBars(ticker: string, bars: Bar[], years?: number): Promise<void> {
  const key = keyFor(ticker, years);
  const env: Envelope = { v: 1, savedAt: Date.now(), bars };
  memory.set(key, env);

  // KV TTL은 stale 한계까지 잡는다. fresh 판정은 savedAt으로 따로 한다.
  // 쓰기 실패는 무시 (다음 요청에서 다시 시도).
  await kvSet(key, JSON.stringify(env), STALE_SECONDS);
}
