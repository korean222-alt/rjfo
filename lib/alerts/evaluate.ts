import { applyFilter } from "@/lib/filter";
import { compactNumber } from "@/lib/format";
import { findChip, type SignalKey } from "@/lib/presets";
import type { EnrichedBar, FilterSpec } from "@/types";

export type SignalHit = {
  signal: SignalKey;
  label: string;
  bar: EnrichedBar;
};

/**
 * "가장 최근 봉이 이 신호에 걸렸는가".
 *
 * 분석 화면과 완전히 같은 필터를 쓴다. 알림용 규칙을 따로 두면 화면과 알림이
 * 서로 다른 말을 하게 되므로, 조건은 lib/presets.ts 한 곳에만 있어야 한다.
 */
export function checkLatest(bars: EnrichedBar[], signal: SignalKey): SignalHit | null {
  const chip = findChip(signal);
  if (!chip || chip.lookahead) return null; // lookahead 신호는 실시간 판정 불가
  if (!bars.length) return null;

  const spec: FilterSpec = {
    conditions: chip.conditions,
    logic: "AND",
    preset: chip.preset,
    interpretation: chip.label,
    confidence: "high",
  };

  const last = bars.length - 1;
  const matched = applyFilter(bars, spec).includes(last);
  return matched ? { signal, label: chip.label, bar: bars[last] } : null;
}

function signed(n: number | null, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** 텔레그램 메시지 본문. 알림만 보고도 무슨 일이 있었는지 알 수 있게 쓴다. */
export function formatAlert(ticker: string, hits: SignalHit[]): string {
  const bar = hits[0].bar;
  const names = hits.map((h) => h.label).join(" · ");
  const ratio = bar.volume_ratio_20d;

  const lines = [
    `🔔 ${ticker} — ${names}`,
    "",
    `${bar.date} 종가 ${bar.close.toFixed(2)} (${signed(bar.close_change_pct)})`,
    `거래량 ${compactNumber(bar.volume)}${ratio != null ? ` (평소의 ${ratio.toFixed(1)}배)` : ""}`,
    `종가 위치 ${(bar.close_position_in_range * 100).toFixed(0)}% (0%=저가, 100%=고가)`,
    "",
    "과거 패턴이며 투자 판단의 근거가 아닙니다.",
  ];
  return lines.join("\n");
}
