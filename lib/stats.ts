import type {
  AnalysisResult,
  EnrichedBar,
  FilterSpec,
  ForwardReturns,
  MatchRow,
  StatBlock,
} from "@/types";
import { applyFilter, clusterIndices } from "./filter";

export const HIT_THRESHOLD_PCT = 10; // "성공" 정의: 20거래일 안에 +10% 이상
export const HORIZON = 20;

/** i번 봉 종가 대비 i+n번 봉 종가 수익률(%). 미래 봉이 모자라면 null. */
export function forwardReturn(
  bars: EnrichedBar[],
  i: number,
  n: number,
): number | null {
  const j = i + n;
  if (j >= bars.length) return null;
  const base = bars[i].close;
  if (!(base > 0)) return null;
  return ((bars[j].close - base) / base) * 100;
}

/** i번 봉 종가 대비 향후 n거래일 고점 기준 최대 수익률(%). 창이 모자라면 null. */
export function maxForwardReturn(
  bars: EnrichedBar[],
  i: number,
  n: number,
): number | null {
  if (i + n >= bars.length) return null;
  const base = bars[i].close;
  if (!(base > 0)) return null;
  let peak = -Infinity;
  for (let k = i + 1; k <= i + n; k++) peak = Math.max(peak, bars[k].high);
  return ((peak - base) / base) * 100;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 인덱스 집합에 대한 승률 / 평균 / 중앙값. 전방 창이 없는 날은 제외한다. */
function summarize(bars: EnrichedBar[], indices: number[]): StatBlock & { sampleCount: number } {
  const returns20: number[] = [];
  const maxReturns: number[] = [];

  for (const i of indices) {
    const r20 = forwardReturn(bars, i, HORIZON);
    const mx = maxForwardReturn(bars, i, HORIZON);
    if (r20 != null) returns20.push(r20);
    if (mx != null) maxReturns.push(mx);
  }

  const hits = maxReturns.filter((r) => r >= HIT_THRESHOLD_PCT).length;

  return {
    sampleCount: returns20.length,
    hitRate: maxReturns.length ? (hits / maxReturns.length) * 100 : null,
    avgReturn20d: mean(returns20),
    medianReturn20d: median(returns20),
  };
}

function inPeriod(date: string, period?: FilterSpec["period"]): boolean {
  if (!period) return true;
  if (period.start && date < period.start) return false;
  if (period.end && date > period.end) return false;
  return true;
}

export type AnalyzeOptions = {
  /** 연속 매칭일을 하나로 묶을지 (중복 카운트 방지). 기본 true. */
  cluster?: boolean;
};

/**
 * 필터 적용 → 매칭일 전방 수익률 → base rate와 비교.
 *
 * baseline이 이 앱의 핵심이다. 조건에 걸린 날의 승률이 45%인데 아무 날이나 골라도 44%라면
 * 그 조건은 아무것도 발견한 게 아니다.
 */
export function analyze(
  ticker: string,
  bars: EnrichedBar[],
  spec: FilterSpec,
  options: AnalyzeOptions = {},
): AnalysisResult {
  let indices = applyFilter(bars, spec);

  const lookahead = spec.lookahead;
  if (lookahead && lookahead.days > 0) {
    indices = indices.filter((i) => {
      const mx = maxForwardReturn(bars, i, lookahead.days);
      return mx != null && mx >= lookahead.min_return_pct;
    });
  }
  return finalize(ticker, bars, spec, indices, options);
}

/** AI 스캔처럼 날짜를 이미 고른 뒤, 같은 성과 비교를 돌린다. */
export function analyzeAtDates(
  ticker: string,
  bars: EnrichedBar[],
  spec: FilterSpec,
  dates: string[],
  options: AnalyzeOptions = {},
): AnalysisResult {
  const indexByDate = new Map(bars.map((b, i) => [b.date, i]));
  const indices = dates
    .map((d) => indexByDate.get(d))
    .filter((i): i is number => i != null)
    .sort((a, b) => a - b);
  return finalize(ticker, bars, spec, indices, { ...options, cluster: false });
}

function finalize(
  ticker: string,
  bars: EnrichedBar[],
  spec: FilterSpec,
  rawIndices: number[],
  options: AnalyzeOptions,
): AnalysisResult {
  const cluster = options.cluster !== false;
  const warnings: string[] = [];
  const lookahead = spec.lookahead;

  let indices = rawIndices;
  let sizes: number[] = indices.map(() => 1);
  if (cluster) {
    const c = clusterIndices(indices);
    indices = c.kept;
    sizes = c.sizes;
  }

  const matches: MatchRow[] = indices.map((i, k) => {
    const b = bars[i];
    const forwardReturns: ForwardReturns = {
      d5: forwardReturn(bars, i, 5),
      d20: forwardReturn(bars, i, 20),
      d60: forwardReturn(bars, i, 60),
    };
    return {
      date: b.date,
      volume: b.volume,
      volumeRatio: b.volume_ratio_20d,
      closeChangePct: b.close_change_pct,
      closePosition: b.close_position_in_range,
      close: b.close,
      fundingPct: b.funding_pct,
      forwardReturns,
      maxForwardReturn20d: maxForwardReturn(bars, i, HORIZON),
      clusterSize: sizes[k],
    };
  });

  const stats = summarize(bars, indices);

  const baselineIndices: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (inPeriod(bars[i].date, spec.period)) baselineIndices.push(i);
  }
  const baseline = summarize(bars, baselineIndices);

  if (matches.length === 0) {
    warnings.push("조건에 맞는 날이 없습니다. 조건을 완화해 보세요.");
  } else if (matches.length < 10) {
    warnings.push("표본이 너무 적어 통계적 의미 없음 (매칭 10일 미만).");
  }

  const usesFunding = spec.conditions.some(
    (c) => "metric" in c && typeof c.metric === "string" && c.metric.startsWith("funding"),
  );
  const fundingDays = bars.filter((b) => b.funding_pct != null).length;
  if (usesFunding && fundingDays < 30) {
    warnings.push("펀딩비는 코인(BTC, ETH 등)만 있습니다. 티커를 BTC로 바꿔 보세요.");
  } else if (usesFunding && fundingDays < bars.length) {
    warnings.push(`펀딩비는 ${fundingDays}일치만 있어 그 구간만 분석했습니다.`);
  }

  const withoutWindow = matches.length - stats.sampleCount;
  if (withoutWindow > 0) {
    warnings.push(
      `최근 ${withoutWindow}일은 20거래일이 아직 지나지 않아 수익률 통계에서 제외했습니다.`,
    );
  }

  return {
    ticker,
    totalBars: bars.length,
    periodStart: bars[0]?.date ?? "",
    periodEnd: bars[bars.length - 1]?.date ?? "",
    matches: [...matches].reverse(),
    stats: { ...stats, matchCount: matches.length },
    baseline,
    edge: {
      hitRateDiff:
        stats.hitRate != null && baseline.hitRate != null
          ? stats.hitRate - baseline.hitRate
          : null,
      avgReturnDiff:
        stats.avgReturn20d != null && baseline.avgReturn20d != null
          ? stats.avgReturn20d - baseline.avgReturn20d
          : null,
    },
    spec,
    warnings,
    lookaheadUsed: Boolean(lookahead && lookahead.days > 0),
    clustered: cluster,
  };
}
