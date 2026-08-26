import { smaValue } from "@/lib/indicators";
import { MAX_MA_PERIOD, clampPeriod } from "@/lib/ma";
import { forwardReturn, maxForwardReturn } from "@/lib/stats";
import type { EnrichedBar } from "@/types";

export type ChartMarker = {
  date: string;
  label: string;
  color: string;
  position: "aboveBar" | "belowBar";
};

export type SurgeEvent = {
  date: string;
  endDate: string;
  returnPct: number;
  lookback: Array<{
    date: string;
    volume: number;
    volumeRatio: number | null;
    fundingPct: number | null;
    closeChangePct: number | null;
  }>;
};

export type BreakoutEvent = {
  date: string;
  close: number;
  ma: number;
  forwardPct: number | null;
};

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 앞으로 windowDays 안에 minReturnPct% 이상 오른 날. 겹치면 앞쪽만 남긴다. */
export function scanSurgePrelude(
  bars: EnrichedBar[],
  opts: { windowDays: number; minReturnPct: number; lookbackDays: number },
): { events: SurgeEvent[]; markers: ChartMarker[]; summary: Record<string, number | null> } {
  const windowDays = Math.min(120, Math.max(2, Math.round(opts.windowDays)));
  const lookbackDays = Math.min(120, Math.max(1, Math.round(opts.lookbackDays)));
  const minReturnPct = opts.minReturnPct;
  const events: SurgeEvent[] = [];
  let i = 0;
  while (i < bars.length) {
    const mx = maxForwardReturn(bars, i, windowDays);
    if (mx == null || mx < minReturnPct) {
      i++;
      continue;
    }
    let end = i + 1;
    let peak = bars[i].close;
    for (let k = i + 1; k <= Math.min(bars.length - 1, i + windowDays); k++) {
      if (bars[k].high > peak) {
        peak = bars[k].high;
        end = k;
      }
    }
    const ret = ((peak - bars[i].close) / bars[i].close) * 100;
    const from = Math.max(0, i - lookbackDays);
    const lookback = bars.slice(from, i).map((b) => ({
      date: b.date,
      volume: b.volume,
      volumeRatio: b.volume_ratio_20d,
      fundingPct: b.funding_pct,
      closeChangePct: b.close_change_pct,
    }));
    events.push({
      date: bars[i].date,
      endDate: bars[end].date,
      returnPct: ret,
      lookback,
    });
    i = end + 1;
  }

  const ratios = events.flatMap((e) => e.lookback.map((d) => d.volumeRatio).filter((n): n is number => n != null));
  const fundings = events.flatMap((e) => e.lookback.map((d) => d.fundingPct).filter((n): n is number => n != null));
  const spikeShare =
    ratios.length === 0 ? null : (ratios.filter((n) => n >= 2).length / ratios.length) * 100;

  const markers: ChartMarker[] = events.map((e) => ({
    date: e.date,
    label: `급등 ${e.returnPct.toFixed(0)}%`,
    color: "#f59e0b",
    position: "belowBar",
  }));

  return {
    events,
    markers,
    summary: {
      count: events.length,
      avgReturn: mean(events.map((e) => e.returnPct)),
      medianReturn: median(events.map((e) => e.returnPct)),
      avgLookbackVolRatio: mean(ratios),
      lookbackSpikeShare: spikeShare,
      avgLookbackFundingPct: mean(fundings),
    },
  };
}

/** 종가가 N일선을 위로 돌파한 날, 그 뒤 holdDays 수익률. */
export function scanMaBreakout(
  bars: EnrichedBar[],
  opts: { period: number; holdDays: number; direction?: "up" | "down" },
): { events: BreakoutEvent[]; markers: ChartMarker[]; summary: Record<string, number | null> } {
  const period = clampPeriod(opts.period, 200);
  const holdDays = Math.min(MAX_MA_PERIOD, Math.max(1, Math.round(opts.holdDays)));
  const direction = opts.direction ?? "up";
  const closes = bars.map((b) => b.close);
  const events: BreakoutEvent[] = [];
  let armed = true;

  for (let i = 1; i < bars.length; i++) {
    const ma = smaValue(closes, i, period);
    const prevMa = smaValue(closes, i - 1, period);
    if (ma == null || prevMa == null) continue;

    if (direction === "up") {
      const up = bars[i - 1].close <= prevMa && bars[i].close > ma;
      if (armed && up) {
        events.push({
          date: bars[i].date,
          close: bars[i].close,
          ma,
          forwardPct: forwardReturn(bars, i, holdDays),
        });
        armed = false;
      } else if (!armed && bars[i].close < ma) {
        armed = true;
      }
    } else {
      const down = bars[i - 1].close >= prevMa && bars[i].close < ma;
      if (armed && down) {
        events.push({
          date: bars[i].date,
          close: bars[i].close,
          ma,
          forwardPct: forwardReturn(bars, i, holdDays),
        });
        armed = false;
      } else if (!armed && bars[i].close > ma) {
        armed = true;
      }
    }
  }

  const forwards = events.map((e) => e.forwardPct).filter((n): n is number => n != null);
  const winShare =
    forwards.length === 0 ? null : (forwards.filter((n) => n > 0).length / forwards.length) * 100;

  const markers: ChartMarker[] = events.map((e) => ({
    date: e.date,
    label: direction === "up" ? `${period}일 돌파` : `${period}일 하향`,
    color: direction === "up" ? "#34d399" : "#f87171",
    position: direction === "up" ? "belowBar" : "aboveBar",
  }));

  return {
    events,
    markers,
    summary: {
      count: events.length,
      avgForward: mean(forwards),
      medianForward: median(forwards),
      winShare,
      holdDays,
      period,
    },
  };
}

export function scanToMatches(events: Array<{ date: string }>, bars: EnrichedBar[]) {
  const byDate = new Map(bars.map((b) => [b.date, b]));
  return events
    .map((e) => byDate.get(e.date))
    .filter((b): b is EnrichedBar => Boolean(b));
}
