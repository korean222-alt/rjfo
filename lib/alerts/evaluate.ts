import { applyFilter } from "@/lib/filter";
import { compactNumber } from "@/lib/format";
import { specForSignal, type SignalKey } from "@/lib/presets";
import { isIncompleteBar } from "@/lib/data/market-clock";
import type { MaParams } from "@/lib/ma";
import type { EnrichedBar } from "@/types";

export type SignalHit = {
  signal: SignalKey;
  label: string;
  bar: EnrichedBar;
};

export function checkLatest(
  bars: EnrichedBar[],
  signal: SignalKey,
  params?: MaParams | null,
  ticker?: string,
): SignalHit | null {
  const spec = specForSignal(signal, params);
  if (!spec) return null;
  if (!bars.length) return null;

  let last = bars.length - 1;
  // 아직 안 끝난 날의 봉으로 신호를 판정하면 장중 값으로 알림이 나가고, 종가가
  // 뒤집히면 없던 신호를 보낸 셈이 된다. 시장별 마감 시각으로 판정한다
  // (코인 UTC 자정 / KRX 15:30 / 미국 16:00 — lib/data/market-clock.ts).
  if (ticker && last > 0 && isIncompleteBar(ticker, bars[last].date)) last -= 1;
  const matched = applyFilter(bars, spec).includes(last);
  return matched ? { signal, label: spec.interpretation, bar: bars[last] } : null;
}

function signed(n: number | null, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function formatAlert(ticker: string, hits: SignalHit[]): string {
  const bar = hits[0].bar;
  const names = hits.map((h) => h.label).join(" · ");
  const ratio = bar.volume_ratio_20d;

  const lines = [
    `🔔 ${ticker} — ${names}`,
    "",
    `${bar.date} 종가 ${bar.close.toFixed(2)} (${signed(bar.close_change_pct)})`,
    `거래량 ${compactNumber(bar.volume)}${ratio != null ? ` (평소의 ${ratio.toFixed(1)}배)` : ""}`,
    bar.funding_pct != null
      ? `펀딩비 ${bar.funding_pct.toFixed(4)}%${bar.funding_zscore_60d != null ? ` (z ${bar.funding_zscore_60d.toFixed(1)})` : ""}`
      : "",
    `종가 위치 ${(bar.close_position_in_range * 100).toFixed(0)}% (0%=저가, 100%=고가)`,
    "",
    "과거 패턴이며 투자 판단의 근거가 아닙니다.",
  ].filter(Boolean);
  return lines.join("\n");
}
