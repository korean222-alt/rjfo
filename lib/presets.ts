import type { Condition, PresetName } from "@/types";

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
};

/** UI 프리셋 칩 — 기존 명령은 원문을 유지하고, 설명에는 검증 가능한 기준을 표시한다. */
export const PRESET_CHIPS: PresetChip[] = [
  {
    label: "거래량 폭발",
    command: "20일 평균 대비 3배 이상 거래량이 터진 날 찾아줘",
    description: "20일 평균 거래량 대비 3.0배 이상",
  },
  {
    label: "물량 흡수",
    command: "거래량은 터졌는데 주가는 거의 안 움직인 날 찾아줘",
    description: "20일 평균 대비 2.0배 이상 · 종가 변동 ±2.0% 이내",
  },
  {
    label: "고가 마감",
    command: "거래량 늘면서 고가 부근에서 마감한 날 찾아줘",
    description: "20일 평균 대비 1.8배 이상 · 당일 고저폭 상위 25%에서 마감",
  },
  {
    label: "급등 직전",
    command: "20일 안에 20% 이상 급등하기 직전에 거래량이 튀었던 날",
    description: "이후 20거래일 안에 +20% 이상 상승한 과거 검증",
  },
  {
    label: "누적 매집",
    command: "세력이 매집한 것 같은 날 찾아줘",
    description: "최근 20일 상승일 거래량합 ÷ 하락일 거래량합 1.5배 이상 · OBV 기울기 0.3 이상",
  },
  {
    label: "상승 전 압축",
    command: "변동성은 줄고 거래량과 종가 위치가 좋아지는 상승 전 압축 신호 찾아줘",
    description: "ATR 비율 0.8 이하 · 20일 평균 거래량 대비 1.2배 이상 · 종가 위치 0.6 이상",
  },
  {
    label: "강한 돌파",
    command: "거래량이 급증하고 2% 이상 오르면서 고가 부근에서 마감한 강한 돌파 신호 찾아줘",
    description: "20일 평균 거래량 대비 2.0배 이상 · +2.0% 이상 · 종가 위치 0.85 이상",
  },
  {
    label: "거래량 확장",
    command: "20일 평균보다 2.5배 이상이고 60일 기준으로도 이례적인 거래량 확장 신호 찾아줘",
    description: "20일 평균 거래량 대비 2.5배 이상 · 60일 z-score 1.5 이상",
  },
  {
    label: "수급 개선",
    command: "상승일 거래량이 우세하고 OBV가 개선되는 수급 개선 신호 찾아줘",
    description: "최근 20일 상승·하락일 거래량 비율 1.4 이상 · OBV 기울기 0.15 이상",
  },
];
