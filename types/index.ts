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
  up_day_ratio_20d: number | null;
  obv: number;
  obv_slope_20d: number | null;
  obv_slope_60d: number | null;
  atr14: number | null;
  atr_ratio_20d: number | null;
  range_ratio_20d: number | null;
  close_vs_sma20_pct: number | null;
  dist_from_high_60d_pct: number | null;
  dist_from_low_60d_pct: number | null;
  vol_ma_ratio_20_50: number | null;
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
  "up_day_ratio_20d",
  "obv_slope_20d",
  "obv_slope_60d",
  "atr_ratio_20d",
  "range_ratio_20d",
  "close_vs_sma20_pct",
  "dist_from_high_60d_pct",
  "dist_from_low_60d_pct",
  "vol_ma_ratio_20_50",
] as const;

export type Metric = (typeof METRICS)[number];

export const OPS = [">=", "<=", ">", "<"] as const;
export type Op = (typeof OPS)[number];

export type Condition = {
  metric: Metric;
  op: Op;
  value: number;
};

export type PresetName =
  | "absorption"
  | "high_close"
  | "accumulation"
  | "squeeze"
  | "volume_expansion"
  | "strong_breakout"
  | "flow_improvement"
  | "stealth_accumulation"
  | "volume_dry_up"
  | "base_breakout"
  | "pullback_support";

/** 국면 묶기 gap 상한 (스펙 검증에서 잘라낸다). */
export const MAX_CLUSTER_GAP = 20;

export type FilterSpec = {
  conditions: Condition[];
  logic: "AND" | "OR";
  lookahead?: {
    days: number; // 향후 N거래일
    min_return_pct: number; // 그 안에 최대 X% 이상 오른 경우만
  };
  period?: { start?: string; end?: string };
  preset?: PresetName | null;
  /**
   * 희귀도 상위 몇 %만 신호로 남길지 (1~100, 100 = 전부).
   *
   * 절대 임계값이 아니라 순위로 자르는 이유: 조건마다 지표 조합이 달라 희귀도의
   * 절대 수준이 비교되지 않는다(가드 성격의 조건이 섞이면 평균이 통째로 내려간다).
   * 순위로 자르면 어떤 조건에서도 "가장 드문 것부터" 남고, 신호가 0개가 되지 않는다.
   */
  top_pct?: number;
  /** 이만큼 이내로 붙은 매칭일을 한 국면으로 묶는다 (1 = 연속일만, 상한 20). */
  cluster_gap?: number;
  /** 국면 대표일을 고르는 방식. "rarest"(기본) = 가장 희귀한 날, "first" = 가장 이른 날. */
  cluster_pick?: "rarest" | "first";
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
  /** 국면에 묶인 첫 날 / 마지막 날 (대표일과 다를 수 있다) */
  clusterStart?: string;
  clusterEnd?: string;
  /** 희귀도 0~100. 조건 지표들이 이 종목 전체 분포에서 얼마나 드문 축인지. */
  rarity: number | null;
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
  /** 신호 정리 전, 조건만 만족한 거래일 수 */
  rawMatchCount: number;
  /** 국면 묶기·희귀도 하한으로 정리된 거래일 수 */
  suppressedCount: number;
  /** 국면 묶기까지 마친 뒤 희귀도 순위에서 밀려 빠진 신호 수 */
  rankedOutCount: number;
  signalRule: { topPct: number; clusterGap: number; clusterPick: "rarest" | "first" };
};
