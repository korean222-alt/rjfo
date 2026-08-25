import type { Condition, FilterSpec, PresetName } from "@/types";

/**
 * 프리셋 조건.
 *
 * 지표는 성격이 둘로 갈린다.
 *  - 이벤트 지표(volume_ratio_20d, close_change_pct …): 그날 하루의 사건. 자연히 드물다.
 *  - 상태 지표(up_down_vol_ratio_20d, obv_slope_20d, atr_ratio_20d …): 20~60일 롤링 창.
 *    한 번 임계값을 넘으면 국면이 끝날 때까지 매일 참이다.
 *
 * 상태 지표만으로 만든 프리셋(누적 매집·수급 개선 등)은 조건을 아무리 다듬어도
 * "한 국면 = 신호 수십 개"가 된다. 그래서 조건 강화와 별개로 PRESET_TRIGGERS의
 * 발화 규칙(첫 진입만 + 최소 간격)을 같이 건다.
 */
export const PRESET_CONDITIONS: Record<PresetName, Condition[]> = {
  // 흡수형: 거래량은 터졌는데 주가는 안 움직임
  absorption: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.0 },
    { metric: "abs_close_change_pct", op: "<=", value: 2.0 },
  ],
  // 고가마감형: 거래량 증가 + 고가 부근 마감
  high_close: [
    { metric: "volume_ratio_20d", op: ">=", value: 1.8 },
    { metric: "close_position_in_range", op: ">=", value: 0.75 },
  ],
  // 누적형: 상승일에 거래량이 몰리고, 거래량 바닥 자체가 올라오며, 아직 안 뜬 자리
  accumulation: [
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 2.0 },
    { metric: "obv_slope_20d", op: ">=", value: 0.6 },
    { metric: "vol_ma_ratio_20_50", op: ">=", value: 1.1 },
    { metric: "close_vs_sma20_pct", op: "<=", value: 12 },
  ],
  // 상승 전 압축: 평소보다 좁아진 변동폭 속에서 거래량·종가 위치가 개선되는지 확인
  squeeze: [
    { metric: "atr_ratio_20d", op: "<=", value: 0.8 },
    { metric: "volume_ratio_20d", op: ">=", value: 1.2 },
    { metric: "close_position_in_range", op: ">=", value: 0.6 },
  ],
  // 거래량 확장: 평소 대비 뚜렷한 거래량 증가가 나온 날
  volume_expansion: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.5 },
    { metric: "volume_zscore_60d", op: ">=", value: 1.5 },
  ],
  // 강한 돌파: 거래량 급증과 함께 고가권에서 강하게 마감한 날
  strong_breakout: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.0 },
    { metric: "close_change_pct", op: ">=", value: 2.0 },
    { metric: "close_position_in_range", op: ">=", value: 0.85 },
  ],
  // 수급 개선: 상승일 거래량 우위와 OBV 방향이 동시에 개선되는지 확인 (누적 매집보다 느슨)
  flow_improvement: [
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 1.6 },
    { metric: "obv_slope_20d", op: ">=", value: 0.3 },
    { metric: "up_day_ratio_20d", op: ">=", value: 0.5 },
  ],
  // 조용한 매집: 변동폭·거래량이 죽어 있는데 OBV만 올라오는 자리
  stealth_accumulation: [
    { metric: "atr_ratio_20d", op: "<=", value: 0.85 },
    { metric: "obv_slope_20d", op: ">=", value: 0.4 },
    { metric: "obv_slope_60d", op: ">=", value: 0.1 },
    { metric: "abs_close_change_pct", op: "<=", value: 3.0 },
    { metric: "close_vs_sma20_pct", op: "<=", value: 8 },
  ],
  // 거래량 소진: 고점 근처에서 거래량이 말라붙은 돌파 대기 구간.
  //
  // volume_ratio_20d나 range_ratio_20d처럼 "그날 값 ÷ 자기 20일 평균"인 지표만 쓰면
  // 조용한 구간에서 분모도 같이 내려가 늘 1 근처가 된다 — 정작 잡아야 할 구간을 못 잡는다.
  // 그래서 20일 거래량 베이스가 50일 베이스보다 낮아졌는지(= 실제로 말라가는 중인지)를 본다.
  volume_dry_up: [
    { metric: "vol_ma_ratio_20_50", op: "<=", value: 0.8 },
    { metric: "volume_ratio_20d", op: "<=", value: 0.9 },
    { metric: "dist_from_high_60d_pct", op: ">=", value: -20 },
  ],
  // 박스 돌파: 직전 60일 최고가를 거래량 동반해 넘어선 날
  base_breakout: [
    { metric: "dist_from_high_60d_pct", op: ">=", value: 0 },
    { metric: "volume_ratio_20d", op: ">=", value: 2.0 },
    { metric: "close_position_in_range", op: ">=", value: 0.7 },
  ],
  // 눌림목 지지: 20일선 부근까지 밀렸는데 파는 물량이 안 나오고 고가권에서 되돌린 날
  pullback_support: [
    { metric: "close_vs_sma20_pct", op: "<=", value: 3 },
    { metric: "close_vs_sma20_pct", op: ">=", value: -8 },
    { metric: "volume_ratio_20d", op: "<=", value: 0.9 },
    { metric: "close_position_in_range", op: ">=", value: 0.6 },
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 1.2 },
  ],
};

export type PresetTrigger = {
  /** 직전 거래일에 조건을 만족하지 않았던 날(= 상태 진입 첫날)만 신호로 센다. */
  fresh_only: boolean;
  /** 직전 신호 이후 최소 N거래일이 지나야 다음 신호를 인정한다. */
  min_gap_days: number;
};

/**
 * 프리셋별 신호 발화 규칙.
 * 상태 지표 기반 프리셋일수록 fresh_only와 긴 min_gap_days가 필요하다.
 */
export const PRESET_TRIGGERS: Record<PresetName, PresetTrigger> = {
  // 이벤트 지표 기반 — 원래 드물게 뜬다. 연속 발화만 막는다.
  absorption: { fresh_only: false, min_gap_days: 5 },
  high_close: { fresh_only: false, min_gap_days: 5 },
  volume_expansion: { fresh_only: false, min_gap_days: 5 },
  strong_breakout: { fresh_only: false, min_gap_days: 5 },
  base_breakout: { fresh_only: false, min_gap_days: 10 },
  // 상태 지표가 섞임 — 진입 첫날만
  squeeze: { fresh_only: true, min_gap_days: 10 },
  volume_dry_up: { fresh_only: true, min_gap_days: 10 },
  pullback_support: { fresh_only: true, min_gap_days: 10 },
  flow_improvement: { fresh_only: true, min_gap_days: 15 },
  // 전부 상태 지표 — 20일 창이 완전히 갈리는 간격을 둔다
  accumulation: { fresh_only: true, min_gap_days: 20 },
  stealth_accumulation: { fresh_only: true, min_gap_days: 20 },
};

export type PresetChip = {
  label: string;
  command: string;
  description: string;
  conditions: Condition[];
  preset: PresetName | null;
  lookahead?: FilterSpec["lookahead"];
};

/** UI 프리셋 카드 — 선택 시 아래 수치 조건을 그대로 적용한다. */
export const PRESET_CHIPS: PresetChip[] = [
  {
    label: "거래량 폭발",
    command: "거래량 폭발: 20일 평균 대비 3.0배 이상 거래량인 날 찾아줘",
    description: "20일 평균 거래량 대비 3.0배 이상",
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 3.0 }],
    preset: null,
  },
  {
    label: "물량 흡수",
    command: "물량 흡수: 20일 평균 대비 거래량 2.0배 이상이고 종가 변동이 ±2.0% 이내인 날 찾아줘",
    description: "거래량 2.0배 이상 · 종가 변동 ±2.0% 이내",
    conditions: PRESET_CONDITIONS.absorption,
    preset: "absorption",
  },
  {
    label: "고가 마감",
    command: "고가 마감: 20일 평균 대비 거래량 1.8배 이상이고 당일 고저폭 상위 25%에서 마감한 날 찾아줘",
    description: "거래량 1.8배 이상 · 당일 고저폭 상위 25% 마감",
    conditions: PRESET_CONDITIONS.high_close,
    preset: "high_close",
  },
  {
    label: "급등 직전",
    command: "급등 직전 검증: 이후 20거래일 안에 20% 이상 상승한 날의 직전 거래량 조건을 검증해줘",
    description: "이후 20거래일 안에 +20% 이상 상승한 과거 검증",
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 2.0 }],
    preset: null,
    lookahead: { days: 20, min_return_pct: 20 },
  },
  {
    label: "누적 매집",
    command:
      "누적 매집: 최근 20일 상승일 거래량 합이 하락일 거래량 합의 2.0배 이상이고 OBV 20일 기울기가 0.6 이상이며 20일 평균 거래량이 50일 평균의 1.1배 이상이고 종가가 20일선 대비 12% 이내인 날 중 조건에 처음 진입한 날만 찾아줘",
    description: "거래량비 2.0 · OBV 0.6 · 거래량 베이스 상승 · 20일선 +12% 이내 · 진입 첫날만",
    conditions: PRESET_CONDITIONS.accumulation,
    preset: "accumulation",
  },
  {
    label: "조용한 매집",
    command:
      "조용한 매집: ATR 비율이 0.85 이하이고 OBV 20일 기울기가 0.4 이상, OBV 60일 기울기가 0.1 이상이며 종가 변동이 ±3% 이내이고 20일선 대비 8% 이내인 날 중 조건에 처음 진입한 날만 찾아줘",
    description: "변동폭 축소 · OBV 20/60일 상승 · 하루 변동 ±3% 이내 · 진입 첫날만",
    conditions: PRESET_CONDITIONS.stealth_accumulation,
    preset: "stealth_accumulation",
  },
  {
    label: "상승 전 압축",
    command: "상승 전 압축: ATR(14)가 20일 평균 ATR의 0.8배 이하이고 거래량이 20일 평균의 1.2배 이상이며 종가가 당일 고저폭 상위 40%에서 마감한 날 찾아줘",
    description: "ATR 비율 0.8 이하 · 거래량 1.2배 이상 · 고저폭 상위 40% 마감",
    conditions: PRESET_CONDITIONS.squeeze,
    preset: "squeeze",
  },
  {
    label: "거래량 소진",
    command:
      "거래량 소진: 20일 평균 거래량이 50일 평균의 0.8배 이하이고 당일 거래량이 20일 평균의 0.9배 이하이며 직전 60일 최고가 대비 -20% 이내인 날 중 조건에 처음 진입한 날만 찾아줘",
    description: "거래량 20일 베이스가 50일 대비 0.8배 이하 · 60일 고점 -20% 이내",
    conditions: PRESET_CONDITIONS.volume_dry_up,
    preset: "volume_dry_up",
  },
  {
    label: "강한 돌파",
    command: "강한 돌파: 20일 평균 대비 거래량 2.0배 이상이고 종가가 2.0% 이상 상승하며 당일 고저폭 상위 15%에서 마감한 날 찾아줘",
    description: "거래량 2.0배 이상 · +2.0% 이상 · 고저폭 상위 15% 마감",
    conditions: PRESET_CONDITIONS.strong_breakout,
    preset: "strong_breakout",
  },
  {
    label: "박스 돌파",
    command:
      "박스 돌파: 종가가 직전 60거래일 최고가를 넘고 거래량이 20일 평균의 2.0배 이상이며 당일 고저폭 상위 30%에서 마감한 날 찾아줘",
    description: "60일 신고가 돌파 · 거래량 2.0배 이상 · 고저폭 상위 30% 마감",
    conditions: PRESET_CONDITIONS.base_breakout,
    preset: "base_breakout",
  },
  {
    label: "거래량 확장",
    command: "거래량 확장: 20일 평균 대비 거래량 2.5배 이상이고 60일 거래량 z-score가 1.5 이상인 날 찾아줘",
    description: "거래량 2.5배 이상 · 60일 z-score 1.5 이상",
    conditions: PRESET_CONDITIONS.volume_expansion,
    preset: "volume_expansion",
  },
  {
    label: "눌림목 지지",
    command:
      "눌림목 지지: 종가가 20일선 대비 -8%에서 +3% 사이이고 거래량이 20일 평균의 0.9배 이하이며 당일 고저폭 상위 40%에서 마감하고 최근 20일 상승일 거래량 합이 하락일의 1.2배 이상인 날 중 조건에 처음 진입한 날만 찾아줘",
    description: "20일선 부근 눌림 · 조정 거래량 감소 · 고저폭 상위 40% 마감",
    conditions: PRESET_CONDITIONS.pullback_support,
    preset: "pullback_support",
  },
  {
    label: "수급 개선",
    command:
      "수급 개선: 최근 20일 상승일 거래량 합이 하락일 거래량 합의 1.6배 이상이고 OBV 20일 기울기가 0.3 이상이며 20일 중 상승일 비율이 50% 이상인 날 중 조건에 처음 진입한 날만 찾아줘",
    description: "거래량비 1.6 이상 · OBV 0.3 이상 · 상승일 비율 50% 이상 · 진입 첫날만",
    conditions: PRESET_CONDITIONS.flow_improvement,
    preset: "flow_improvement",
  },
];
