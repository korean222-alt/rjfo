import { kvConfigured, kvGet, kvSet } from "@/lib/kv";
import type { MaParams } from "@/lib/ma";
import { findChip, normalizeMaParams, type SignalKey } from "@/lib/presets";

const KEY = "alerts:watchlist";
export const MAX_TICKERS = 8;

export type Watch = {
  id: string;
  ticker: string;
  signal: SignalKey;
  createdAt: string;
  lastNotifiedDate?: string;
  params?: MaParams;
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

function paramsKey(params?: MaParams): string {
  if (!params) return "";
  return JSON.stringify({
    short: params.short ?? null,
    long: params.long ?? null,
    period: params.period ?? null,
  });
}

function sameWatch(a: Watch, ticker: string, signal: SignalKey, params?: MaParams): boolean {
  return a.ticker === ticker && a.signal === signal && paramsKey(a.params) === paramsKey(params);
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
      const signal = w.signal as SignalKey;
      const rawParams =
        w.params && typeof w.params === "object"
          ? {
              short: typeof w.params.short === "number" ? w.params.short : undefined,
              long: typeof w.params.long === "number" ? w.params.long : undefined,
              period: typeof w.params.period === "number" ? w.params.period : undefined,
            }
          : undefined;
      return [
        {
          id: w.id,
          ticker: w.ticker,
          signal,
          createdAt: typeof w.createdAt === "string" ? w.createdAt : new Date().toISOString(),
          lastNotifiedDate: typeof w.lastNotifiedDate === "string" ? w.lastNotifiedDate : undefined,
          params: normalizeMaParams(signal, rawParams),
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

export async function addWatch(ticker: string, signal: SignalKey, params?: MaParams): Promise<Watch[]> {
  requireKv();
  const chip = findChip(signal);
  if (!chip) throw new AlertStoreError("알 수 없는 신호입니다.");
  if (chip.lookahead) {
    throw new AlertStoreError(
      `'${chip.label}'은 이후에 실제로 올랐는지를 보고 고르는 과거 검증용이라 알림으로 받을 수 없습니다.`,
    );
  }

  const normalized = normalizeMaParams(signal, params);
  const watches = await listWatches();
  if (watches.some((w) => sameWatch(w, ticker, signal, normalized))) {
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
      id: `${ticker}:${signal}:${paramsKey(normalized) || "default"}:${Date.now().toString(36)}`,
      ticker,
      signal,
      createdAt: new Date().toISOString(),
      params: normalized,
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

export async function markNotified(marks: { id: string; date: string }[]): Promise<void> {
  if (!marks.length) return;
  const byId = new Map(marks.map((m) => [m.id, m.date]));
  const watches = await listWatches();
  await save(
    watches.map((w) => (byId.has(w.id) ? { ...w, lastNotifiedDate: byId.get(w.id) } : w)),
  );
}
