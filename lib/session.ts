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
