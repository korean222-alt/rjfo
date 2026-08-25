import { kvConfigured, kvGet, kvSet } from "@/lib/kv";
import { findChip, type SignalKey } from "@/lib/presets";

/**
 * 알림 워치리스트.
 *
 * 하나의 KV 키에 배열을 통째로 담는다. 이 앱의 워치리스트는 최대 수십 건이라
 * 인덱스를 나눌 이유가 없고, 크론이 읽고 고치는 지점도 한 곳뿐이라 이게 제일 단순하다.
 */

const KEY = "alerts:watchlist";

/** 크론 한 번에 시세 소스를 몇 번 두드릴지의 상한. Twelve Data 무료 등급이 분당 8회다. */
export const MAX_TICKERS = 8;

export type Watch = {
  id: string;
  ticker: string;
  signal: SignalKey;
  createdAt: string; // ISO
  /** 같은 날 신호로 두 번 알리지 않기 위한 표식 (YYYY-MM-DD) */
  lastNotifiedDate?: string;
};

export class AlertStoreError extends Error {}

export function alertsAvailable(): boolean {
  return kvConfigured();
}

function requireKv(): void {
  if (!kvConfigured()) {
    throw new AlertStoreError(
      "알림을 저장하려면 Vercel KV 연결이 필요합니다. " +
        "Vercel 프로젝트에 KV(Upstash Redis) 스토어를 연결하면 자동으로 설정됩니다.",
    );
  }
}

function parse(raw: string | null): Watch[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const w = item as Partial<Watch>;
      if (typeof w.id !== "string" || typeof w.ticker !== "string") return [];
      if (typeof w.signal !== "string" || !findChip(w.signal)) return [];
      return [
        {
          id: w.id,
          ticker: w.ticker,
          signal: w.signal as SignalKey,
          createdAt: typeof w.createdAt === "string" ? w.createdAt : new Date().toISOString(),
          lastNotifiedDate:
            typeof w.lastNotifiedDate === "string" ? w.lastNotifiedDate : undefined,
        },
      ];
    });
  } catch {
    return [];
  }
}

export async function listWatches(): Promise<Watch[]> {
  requireKv();
  return parse(await kvGet(KEY));
}

async function save(watches: Watch[]): Promise<void> {
  const ok = await kvSet(KEY, JSON.stringify(watches));
  if (!ok) throw new AlertStoreError("알림 목록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
}

export async function addWatch(ticker: string, signal: SignalKey): Promise<Watch[]> {
  requireKv();
  const chip = findChip(signal);
  if (!chip) throw new AlertStoreError("알 수 없는 신호입니다.");
  if (chip.lookahead) {
    throw new AlertStoreError(
      `'${chip.label}'은 이후에 실제로 올랐는지를 보고 고르는 과거 검증용이라 알림으로 받을 수 없습니다.`,
    );
  }

  const watches = await listWatches();
  if (watches.some((w) => w.ticker === ticker && w.signal === signal)) {
    throw new AlertStoreError("이미 등록된 알림입니다.");
  }

  const tickers = new Set(watches.map((w) => w.ticker));
  if (!tickers.has(ticker) && tickers.size >= MAX_TICKERS) {
    throw new AlertStoreError(
      `종목은 최대 ${MAX_TICKERS}개까지 등록할 수 있습니다. (시세 API 한도 때문입니다)`,
    );
  }

  const next: Watch[] = [
    ...watches,
    {
      id: `${ticker}:${signal}:${Date.now().toString(36)}`,
      ticker,
      signal,
      createdAt: new Date().toISOString(),
    },
  ];
  await save(next);
  return next;
}

export async function removeWatch(id: string): Promise<Watch[]> {
  requireKv();
  const watches = await listWatches();
  const next = watches.filter((w) => w.id !== id);
  if (next.length === watches.length) throw new AlertStoreError("해당 알림을 찾지 못했습니다.");
  await save(next);
  return next;
}

/** 크론이 알림을 보낸 뒤, 같은 날 중복 발송을 막기 위해 표식을 남긴다. */
export async function markNotified(marks: { id: string; date: string }[]): Promise<void> {
  if (!marks.length) return;
  const byId = new Map(marks.map((m) => [m.id, m.date]));
  const watches = await listWatches();
  await save(
    watches.map((w) => (byId.has(w.id) ? { ...w, lastNotifiedDate: byId.get(w.id) } : w)),
  );
}
