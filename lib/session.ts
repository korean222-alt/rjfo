import type { AnalysisResult } from "@/types";
import type { SeriesPoint } from "@/components/VolumeChart";

export type AnalysisPayload = {
  result: AnalysisResult;
  series: SeriesPoint[];
};

export type SearchDraft = {
  ticker: string;
  command: string;
};

const ANALYSIS_KEY = "volume-analyzer:last";
const DRAFT_KEY = "volume-analyzer:search-draft";

/** 결과는 payload가 커서 URL로 넘기지 않고 sessionStorage로 전달한다. */
export function saveAnalysis(payload: AnalysisPayload): void {
  try {
    sessionStorage.setItem(ANALYSIS_KEY, JSON.stringify(payload));
  } catch {
    // 저장 실패 시에도 앱이 죽지 않도록 (사파리 프라이빗 모드 등)
  }
}

export function loadAnalysis(): AnalysisPayload | null {
  try {
    const raw = sessionStorage.getItem(ANALYSIS_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw) as AnalysisPayload;
    // 배포 전에 저장된 결과에는 신호 정리 필드가 없다. 화면이 죽는 대신 버린다.
    if (!payload?.result?.signalRule || typeof payload.result.rawMatchCount !== "number") {
      sessionStorage.removeItem(ANALYSIS_KEY);
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** 최근 검색 조건은 재방문 편의를 위해 브라우저에 오래 보관한다. */
export function saveSearchDraft(draft: SearchDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // 저장 공간이 막혀도 검색 기능 자체는 계속 동작한다.
  }
}

export function loadSearchDraft(): SearchDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<SearchDraft>;
    if (typeof draft.ticker !== "string" || typeof draft.command !== "string") return null;
    return { ticker: draft.ticker, command: draft.command };
  } catch {
    return null;
  }
}

// ── 브라우저가 직접 받아온 일봉 ──────────────────────────────────────
// 서버가 시세 소스에 막혔을 때 폴백으로 받아둔 것. 결과 화면에서 다시 계산할 때
// 또 받으러 가지 않도록 티커별로 들고 있는다.
const BARS_KEY = "volume-analyzer:bars";

export function saveClientBars(ticker: string, bars: unknown): void {
  try {
    sessionStorage.setItem(BARS_KEY, JSON.stringify({ ticker, bars }));
  } catch {
    // 용량 초과 등은 무시 — 없으면 서버 경로로 다시 시도할 뿐이다.
  }
}

export function loadClientBars(ticker: string): unknown | null {
  try {
    const raw = sessionStorage.getItem(BARS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { ticker?: string; bars?: unknown };
    return saved.ticker === ticker && saved.bars ? saved.bars : null;
  } catch {
    return null;
  }
}

// ── 이동평균선 설정 ─────────────────────────────────────────────────
// 골든/데드크로스에 쓸 기간. 사용자가 정하는 값이라 브라우저에 오래 보관한다.
const MA_KEY = "volume-analyzer:ma";

export type MaSettings = {
  enabled: boolean;
  fast: number;
  slow: number;
};

export const DEFAULT_MA: MaSettings = { enabled: true, fast: 20, slow: 60 };

export function saveMaSettings(settings: MaSettings): void {
  try {
    localStorage.setItem(MA_KEY, JSON.stringify(settings));
  } catch {
    // 저장이 막혀도 차트는 그대로 그려진다.
  }
}

export function loadMaSettings(): MaSettings {
  try {
    const raw = localStorage.getItem(MA_KEY);
    if (!raw) return DEFAULT_MA;
    const saved = JSON.parse(raw) as Partial<MaSettings>;
    const fast = Number(saved.fast);
    const slow = Number(saved.slow);
    if (!isFinite(fast) || !isFinite(slow)) return DEFAULT_MA;
    return {
      enabled: saved.enabled !== false,
      fast: Math.round(fast),
      slow: Math.round(slow),
    };
  } catch {
    return DEFAULT_MA;
  }
}
