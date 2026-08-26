// ── 데이터 ─────────────────────────────────────────────────
export type Bar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 일평균 펀딩비(소수). 0.0001 = 0.01%. 코인만 있음. */
  funding?: number | null;
};

export type EnrichedBar = Bar & {
  vol_ma20: number | null;
  vol_ma50: number | null;
  volume_ratio_20d: number | null;
  volume_zscore_60d: number | null;
  dollar_volume: number;
  close_change_pct: number | null;
  abs_close_change_pct: number | null;
  close_position_in_range: number;
  range_pct: number;
  up_down_vol_ratio_20d: number | null;
  obv: number;
  obv_slope_20d: number | null;
  atr14: number | null;
  atr_ratio_20d: number | null;
  funding_pct: number | null;
  funding_zscore_60d: number | null;
  funding_z_abs: number | null;
  funding_abs: number | null;
  funding_flip: number | null;
};

export const METRICS = [
  "volume",
  "dollar_volume",
  "volume_ratio_20d",
  "volume_zscore_60d",
  "close_change_pct",
  "abs_close_change_pct",
  "close_position_in_range",
  "range_pct",
  "up_down_vol_ratio_20d",
  "obv_slope_20d",
  "atr_ratio_20d",
  "funding_pct",
  "funding_zscore_60d",
  "funding_z_abs",
  "funding_abs",
  "funding_flip",
] as const;

export type Metric = (typeof METRICS)[number];

export const OPS = [">=", "<=", ">", "<"] as const;
export type Op = (typeof OPS)[number];

export type MetricCondition = {
  kind?: "metric";
  metric: Metric;
  op: Op;
  value: number;
};

export type MaCrossCondition = {
  kind: "ma_cross";
  short: number;
  long: number;
  direction: "golden" | "death";
};

export type MaTouchCondition = {
  kind: "ma_touch";
  period: number;
};

export type MaBreakoutCondition = {
  kind: "ma_breakout";
  period: number;
  direction: "up" | "down";
};

export type Condition = MetricCondition | MaCrossCondition | MaTouchCondition | MaBreakoutCondition;


export type PresetName =
  | "absorption"
  | "high_close"
  | "accumulation"
  | "squeeze"
  | "volume_expansion"
  | "strong_breakout"
  | "flow_improvement"
  | "funding_heat"
  | "funding_short"
  | "funding_flip"
  | "funding_absorption";

export type FilterSpec = {
  conditions: Condition[];
  logic: "AND" | "OR";
  lookahead?: {
    days: number;
    min_return_pct: number;
  };
  period?: { start?: string; end?: string };
  preset?: PresetName | null;
  interpretation: string;
  confidence: "high" | "low";
};

export type ForwardReturns = {
  d5: number | null;
  d20: number | null;
  d60: number | null;
};

export type MatchRow = {
  date: string;
  volume: number;
  volumeRatio: number | null;
  closeChangePct: number | null;
  closePosition: number;
  close: number;
  fundingPct: number | null;
  forwardReturns: ForwardReturns;
  maxForwardReturn20d: number | null;
  clusterSize?: number;
};

export type StatBlock = {
  hitRate: number | null;
  avgReturn20d: number | null;
  medianReturn20d: number | null;
};

export type AnalysisResult = {
  ticker: string;
  totalBars: number;
  periodStart: string;
  periodEnd: string;
  matches: MatchRow[];
  stats: StatBlock & { matchCount: number };
  baseline: StatBlock & { sampleCount: number };
  edge: {
    hitRateDiff: number | null;
    avgReturnDiff: number | null;
  };
  spec: FilterSpec;
  warnings: string[];
  lookaheadUsed: boolean;
  clustered: boolean;
};
