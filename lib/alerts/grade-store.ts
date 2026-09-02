import { KvUnavailableError, kvConfigured, kvGet, kvSet } from "@/lib/kv";
import { AlertStoreError } from "./store";

/**
 * 'A등급 신호' 알림 워치리스트.
 *
 * 기존 알림(lib/alerts/store.ts)은 "이 종목에 이 조건이 뜨면 알려줘"였다. 여기는 조건을
 * 사람이 고르지 않는다 — 종목만 등록하면, 그 종목의 과거 사이클로 채점해서 여섯 관문을
 * 다 통과한(A등급) 신호가 새로 켜질 때만 알린다. 무엇을 볼지는 데이터가 정한다.
 *
 * 종목 수를 조금만 받는 이유: 한 종목당 20년치 일봉 + 지표 31개 + 조합 수십 개를
 * 채점하므로, 크론 함수 하나(60초) 안에 끝나야 한다.
 */

const KEY = "alerts:grade";
export const MAX_GRADE_TICKERS = 5;

export type GradeWatch = {
  ticker: string;
  createdAt: string;
  /**
   * 이미 알린 신호. 키는 `신호키@신호일`이고 값은 보낸 날짜다.
   * 신호일까지 키에 넣어 두면, 같은 지표가 다음 사이클에 다시 켜질 때는 새 알림이 간다.
   */
  notified?: Record<string, string>;
};

function requireKv(): void {
  if (!kvConfigured()) {
    throw new AlertStoreError(
      "알림을 저장하려면 Vercel KV 연결이 필요합니다. " +
        "Vercel 프로젝트에 KV(Upstash Redis) 스토어를 연결하면 자동으로 설정됩니다.",
    );
  }
}

function parse(raw: string | null): GradeWatch[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const w = item as Partial<GradeWatch>;
      if (typeof w.ticker !== "string" || !w.ticker) return [];
      const notified: Record<string, string> = {};
      if (w.notified && typeof w.notified === "object") {
        for (const [k, v] of Object.entries(w.notified)) {
          if (typeof v === "string") notified[k] = v;
        }
      }
      return [
        {
          ticker: w.ticker,
          createdAt: typeof w.createdAt === "string" ? w.createdAt : new Date().toISOString(),
          notified,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** 읽기 실패를 빈 목록으로 흘리면 안 되는 이유는 store.ts의 listWatches 주석 참고. */
export async function listGradeWatches(): Promise<GradeWatch[]> {
  requireKv();
  try {
    return parse(await kvGet(KEY));
  } catch (e) {
    if (e instanceof KvUnavailableError) {
      throw new AlertStoreError(
        `알림 저장소를 읽지 못했습니다 (${e.message}) 등록된 종목이 지워지지 않도록 아무것도 바꾸지 않았습니다. 잠시 후 다시 시도해 주세요.`,
      );
    }
    throw e;
  }
}

async function save(watches: GradeWatch[]): Promise<void> {
  const ok = await kvSet(KEY, JSON.stringify(watches));
  if (!ok) throw new AlertStoreError("알림 목록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
}

export async function addGradeWatch(ticker: string): Promise<GradeWatch[]> {
  requireKv();
  const watches = await listGradeWatches();
  if (watches.some((w) => w.ticker === ticker)) {
    throw new AlertStoreError("이미 등록된 종목입니다.");
  }
  if (watches.length >= MAX_GRADE_TICKERS) {
    throw new AlertStoreError(
      `A등급 알림은 종목 ${MAX_GRADE_TICKERS}개까지 등록할 수 있습니다. ` +
        "(한 종목마다 20년치를 다시 채점하기 때문입니다)",
    );
  }
  const next = [...watches, { ticker, createdAt: new Date().toISOString(), notified: {} }];
  await save(next);
  return next;
}

export async function removeGradeWatch(ticker: string): Promise<GradeWatch[]> {
  requireKv();
  const watches = await listGradeWatches();
  const next = watches.filter((w) => w.ticker !== ticker);
  if (next.length === watches.length) throw new AlertStoreError("해당 종목을 찾지 못했습니다.");
  await save(next);
  return next;
}

/**
 * 보낸 알림 기록. 오래된 기록은 버린다 — 한 종목의 신호 기록이 무한정 쌓이면
 * KV 값 하나가 계속 커진다. 최근 것만 있으면 중복 방지에는 충분하다.
 */
const KEEP_NOTIFIED = 40;

export async function markGradeNotified(
  marks: { ticker: string; keys: string[]; date: string }[],
): Promise<void> {
  if (!marks.length) return;
  const byTicker = new Map(marks.map((m) => [m.ticker, m]));
  const watches = await listGradeWatches();
  await save(
    watches.map((w) => {
      const mark = byTicker.get(w.ticker);
      if (!mark) return w;
      const merged: Record<string, string> = { ...(w.notified ?? {}) };
      for (const key of mark.keys) merged[key] = mark.date;
      const trimmed = Object.entries(merged)
        .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
        .slice(0, KEEP_NOTIFIED);
      return { ...w, notified: Object.fromEntries(trimmed) };
    }),
  );
}
