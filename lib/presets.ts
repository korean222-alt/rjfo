import type { Condition, FilterSpec, PresetName } from "@/types";

export const PRESET_CONDITIONS: Record<PresetName, Condition[]> = {
  // 기존 흡수형: 거래량은 터졌는데 주가는 안 움직임
  absorption: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.0 },
    { metric: "abs_close_change_pct", op: "<=", value: 2.0 },
  ],
  // 기존 고가마감형: 거래량 증가 + 고가 부근 마감
  high_close: [
    { metric: "volume_ratio_20d", op: ">=", value: 1.8 },
    { metric: "close_position_in_range", op: ">=", value: 0.75 },
  ],
  // 기존 누적형: 상승일에 거래량이 몰림
  accumulation: [
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 1.5 },
    { metric: "obv_slope_20d", op: ">=", value: 0.3 },
  ],
  // 새 상승 전 압축: 평소보다 좁아진 변동폭 속에서 거래량·종가 위치가 개선되는지 확인
  squeeze: [
    { metric: "atr_ratio_20d", op: "<=", value: 0.8 },
    { metric: "volume_ratio_20d", op: ">=", value: 1.2 },
    { metric: "close_position_in_range", op: ">=", value: 0.6 },
  ],
  // 새 거래량 확장: 평소 대비 뚜렷한 거래량 증가가 나온 날
  volume_expansion: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.5 },
    { metric: "volume_zscore_60d", op: ">=", value: 1.5 },
  ],
  // 새 강한 돌파: 거래량 급증과 함께 고가권에서 강하게 마감한 날
  strong_breakout: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.0 },
    { metric: "close_change_pct", op: ">=", value: 2.0 },
    { metric: "close_position_in_range", op: ">=", value: 0.85 },
  ],
  // 새 수급 개선: 상승일 거래량 우위와 OBV 방향이 동시에 개선되는지 확인
  flow_improvement: [
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 1.4 },
    { metric: "obv_slope_20d", op: ">=", value: 0.15 },
  ],
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
    command: "누적 매집: 최근 20일 상승일 거래량 합이 하락일 거래량 합의 1.5배 이상이고 OBV 20일 기울기가 0.3 이상인 날 찾아줘",
    description: "상승·하락일 거래량 비율 1.5 이상 · OBV 20일 기울기 0.3 이상",
    conditions: PRESET_CONDITIONS.accumulation,
    preset: "accumulation",
  },
  {
    label: "상승 전 압축",
    command: "상승 전 압축: ATR(14)가 20일 평균 ATR의 0.8배 이하이고 거래량이 20일 평균의 1.2배 이상이며 종가가 당일 고저폭 상위 40%에서 마감한 날 찾아줘",
    description: "ATR 비율 0.8 이하 · 거래량 1.2배 이상 · 고저폭 상위 40% 마감",
    conditions: PRESET_CONDITIONS.squeeze,
    preset: "squeeze",
  },
  {
    label: "강한 돌파",
    command: "강한 돌파: 20일 평균 대비 거래량 2.0배 이상이고 종가가 2.0% 이상 상승하며 당일 고저폭 상위 15%에서 마감한 날 찾아줘",
    description: "거래량 2.0배 이상 · +2.0% 이상 · 고저폭 상위 15% 마감",
    conditions: PRESET_CONDITIONS.strong_breakout,
    preset: "strong_breakout",
  },
  {
    label: "거래량 확장",
    command: "거래량 확장: 20일 평균 대비 거래량 2.5배 이상이고 60일 거래량 z-score가 1.5 이상인 날 찾아줘",
    description: "거래량 2.5배 이상 · 60일 z-score 1.5 이상",
    conditions: PRESET_CONDITIONS.volume_expansion,
    preset: "volume_expansion",
  },
  {
    label: "수급 개선",
    command: "수급 개선: 최근 20일 상승일 거래량 합이 하락일 거래량 합의 1.4배 이상이고 OBV 20일 기울기가 0.15 이상인 날 찾아줘",
    description: "상승·하락일 거래량 비율 1.4 이상 · OBV 20일 기울기 0.15 이상",
    conditions: PRESET_CONDITIONS.flow_improvement,
    preset: "flow_improvement",
  },
];
