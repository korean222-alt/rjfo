import type { AnalysisResult } from "@/types";
import type { ChartMarker, SeriesPoint } from "@/components/VolumeChart";

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
    return raw ? (JSON.parse(raw) as AnalysisPayload) : null;
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

const MARKERS_KEY = "volume-analyzer:ai-markers";

export function saveAiMarkers(markers: ChartMarker[]): void {
  try {
    sessionStorage.setItem(MARKERS_KEY, JSON.stringify(markers));
  } catch {
    // ignore
  }
}

export function loadAiMarkers(): ChartMarker[] {
  try {
    const raw = sessionStorage.getItem(MARKERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChartMarker[];
    return Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.date === "string") : [];
  } catch {
    return [];
  }
}

export function clearAiMarkers(): void {
  try {
    sessionStorage.removeItem(MARKERS_KEY);
  } catch {
    // ignore
  }
}

const OVERLAY_KEY = "volume-analyzer:overlay-ma";

export function saveOverlayPeriods(periods: number[]): void {
  try {
    sessionStorage.setItem(OVERLAY_KEY, JSON.stringify(periods));
  } catch {
    // ignore
  }
}

export function loadOverlayPeriods(): number[] {
  try {
    const raw = sessionStorage.getItem(OVERLAY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number" && n >= 2 && n <= 500);
  } catch {
    return [];
  }
}

// ── 상승장 지표 탭 ──────────────────────────────────────────────────
// 리포트는 지표 31개 × 사이클별 상세라 payload가 작지 않다. 탭을 오갈 때
// 매번 20년치를 다시 받지 않도록 sessionStorage에 들고 있는다 (일봉 자체는 넣지 않는다).
//
// 키에 버전을 붙인다: 채점 규칙이 바뀌면(적중 정의, 우연일 확률 계산 등) 예전에 저장된
// 리포트는 새 화면이 기대하는 필드가 없어 숫자가 비거나 옛 기준으로 잘못 읽힌다.
// 버전을 올리면 그냥 다시 분석한다.
const CYCLE_KEY = "volume-analyzer:cycle:v3";
const CYCLE_KEYS_OLD = ["volume-analyzer:cycle", "volume-analyzer:cycle:v2"];

export function saveCycle(payload: unknown): void {
  try {
    for (const k of CYCLE_KEYS_OLD) sessionStorage.removeItem(k);
    sessionStorage.setItem(CYCLE_KEY, JSON.stringify(payload));
  } catch {
    // 용량 초과 등은 무시 — 없으면 다시 분석할 뿐이다.
  }
}

export function loadCycle<T>(): T | null {
  try {
    for (const k of CYCLE_KEYS_OLD) sessionStorage.removeItem(k);
    const raw = sessionStorage.getItem(CYCLE_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function clearCycle(): void {
  try {
    for (const k of CYCLE_KEYS_OLD) sessionStorage.removeItem(k);
    sessionStorage.removeItem(CYCLE_KEY);
  } catch {
    // ignore
  }
}

// ── 캔들 분석 탭 ────────────────────────────────────────────────────
// 사이클과 같은 이유로 들고 있는다. 키에 버전을 붙이는 이유도 같다 —
// 채점 규칙(관문, 채점 구간 등)이 바뀌면 예전 리포트는 새 화면이 기대하는 필드가 없다.
const CANDLE_KEY = "volume-analyzer:candle:v1";

export function saveCandle(payload: unknown): void {
  try {
    sessionStorage.setItem(CANDLE_KEY, JSON.stringify(payload));
  } catch {
    // 용량 초과 등은 무시 — 없으면 다시 분석할 뿐이다.
  }
}

export function loadCandle<T>(): T | null {
  try {
    const raw = sessionStorage.getItem(CANDLE_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function clearCandle(): void {
  try {
    sessionStorage.removeItem(CANDLE_KEY);
  } catch {
    // ignore
  }
}
