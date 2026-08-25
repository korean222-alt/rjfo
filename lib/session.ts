import type { AnalysisResult } from "@/types";
import type { SeriesPoint } from "@/components/VolumeChart";

export type AnalysisPayload = {
  result: AnalysisResult;
  series: SeriesPoint[];
};

const KEY = "volume-analyzer:last";

/** 결과는 payload가 커서 URL로 넘기지 않고 sessionStorage로 전달한다. */
export function saveAnalysis(payload: AnalysisPayload): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // 저장 실패 시에도 앱이 죽지 않도록 (사파리 프라이빗 모드 등)
  }
}

export function loadAnalysis(): AnalysisPayload | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AnalysisPayload) : null;
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
