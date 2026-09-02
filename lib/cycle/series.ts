/**
 * 차트용 시계열 만들기 (서버 → 브라우저).
 *
 * 브라우저는 이 배열에 같은 enrich()를 다시 돌려 지표를 그린다. 그래서 여기서
 * 빠뜨린 필드는 화면에서 '그 지표만 텅 빈 패널'이 된다 — 성적표에는 채점 결과가
 * 멀쩡히 있는데 차트만 비어서, 원인을 찾기가 유난히 어렵다. 실제로 펀딩비가
 * 그랬다. 라우트 안에 인라인으로 두면 또 조용히 어긋나므로 여기 한 군데에 둔다.
 *
 * funding은 반드시 소수 원값(0.0001 = 0.01%)이다. 이미 %로 바꾼 값을 넣으면
 * enrich()가 다시 100을 곱해 100배가 된다.
 */

import type { Bar, EnrichedBar } from "@/types";

/** 20년치면 5,000봉이라 자릿수를 줄여 payload를 절반으로 만든다. */
function round(v: number): number {
  const abs = Math.abs(v);
  if (abs >= 1000) return Number(v.toFixed(1));
  if (abs >= 1) return Number(v.toFixed(3));
  return Number(v.toFixed(8));
}

export function toChartSeries(bars: EnrichedBar[]): Bar[] {
  return bars.map((b) => ({
    date: b.date,
    open: round(b.open),
    high: round(b.high),
    low: round(b.low),
    close: round(b.close),
    volume: Math.round(b.volume),
    ...(b.funding != null && Number.isFinite(b.funding) ? { funding: b.funding } : {}),
  }));
}
