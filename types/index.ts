// ── 데이터 ─────────────────────────────────────────────────────────
export type Bar = {
  date: string; // YYYY-MM-DD (거래소 기준 문자열. Date 타임존 변환에 의존하지 않는다)
  open: number;
  high: number;
  low: number;
  close: number; // adjusted
  volume: number; // adjusted
};

// ── 파생 지표 ───────────────────────────────────────────────────────
// 워밍업 구간(20~60봉)에서는 null. 필터가 자동으로 제외한다.
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
};

// ── FilterSpec ─────────────────────────────────────────────────────
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
] as const;

export type Metric = (typeof METRICS)[number];

export const OPS = [">=", "<=", ">", "<"] as const;
export type Op = (typeof OPS)[number];

export type Condition = {
  metric: Metric;
  op: Op;
  value: number;
};

export type PresetName = "absorption" | "high_close" | "accumulation";

export type FilterSpec = {
  conditions: Condition[];
  logic: "AND" | "OR";
  lookahead?: {
    days: number; // 향후 N거래일
    min_return_pct: number; // 그 안에 최대 X% 이상 오른 경우만
  };
  period?: { start?: string; end?: string };
  preset?: PresetName | null;
  interpretation: string;
  confidence: "high" | "low";
};

// ── 분석 결과 ───────────────────────────────────────────────────────
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
  forwardReturns: ForwardReturns;
  maxForwardReturn20d: number | null;
  clusterSize?: number; // 클러스터 병합 시 묶인 날짜 수
};

export type StatBlock = {
  hitRate: number | null; // 20일 내 +10% 이상 간 비율 (%)
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
