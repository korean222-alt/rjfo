import type { Condition, PresetName } from "@/types";

export const PRESET_CONDITIONS: Record<PresetName, Condition[]> = {
  // 이전 저장 결과 재계산을 위한 호환용 별칭. 새 명령은 accumulation으로 통합한다.
  absorption: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.0 },
    { metric: "abs_close_change_pct", op: "<=", value: 2.0 },
  ],
  // 초기 돌파: 거래량이 늘고, 상승한 채로 당일 고가 부근에서 마감
  high_close: [
    { metric: "volume_ratio_20d", op: ">=", value: 1.8 },
    { metric: "close_change_pct", op: ">=", value: 1.0 },
    { metric: "close_position_in_range", op: ">=", value: 0.75 },
  ],
  // 매집 신호: 물량 흡수와 누적 수급을 한 번에 확인
  accumulation: [
    { metric: "volume_ratio_20d", op: ">=", value: 1.5 },
    { metric: "abs_close_change_pct", op: "<=", value: 2.5 },
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 1.2 },
    { metric: "obv_slope_20d", op: ">=", value: 0 },
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
  // 수급 개선: 상승일 거래량 우위와 OBV 방향이 동시에 개선되는지 확인
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

/** UI 프리셋 칩 — 탭하면 명령창에 텍스트를 삽입한다. */
export const PRESET_CHIPS: PresetChip[] = [
  {
    label: "매집 신호",
    command: "거래량이 늘지만 주가가 눌리고 수급이 누적된 매집 신호 찾아줘",
    description: "거래량·작은 가격 변동·상승일 수급·OBV를 함께 확인",
  },
  {
    label: "상승 전 압축",
    command: "변동성은 줄고 거래량과 종가 위치가 좋아지는 상승 전 압축 신호 찾아줘",
    description: "변동폭이 줄어든 뒤 매수 압력이 붙는지 관찰",
  },
  {
    label: "초기 돌파",
    command: "거래량이 늘면서 상승한 채 고가 부근에서 마감한 초기 돌파 신호 찾아줘",
    description: "거래량을 동반한 고가권 마감 확인",
  },
  {
    label: "강한 돌파",
    command: "거래량이 급증하고 2% 이상 오르면서 고가 부근에서 마감한 강한 돌파 신호 찾아줘",
    description: "초기 돌파보다 강한 당일 가격·거래량 확장",
  },
  {
    label: "거래량 확장",
    command: "20일 평균보다 2.5배 이상이고 60일 기준으로도 이례적인 거래량 확장 신호 찾아줘",
    description: "평소 대비 이례적인 거래량 증가만 먼저 선별",
  },
  {
    label: "수급 개선",
    command: "상승일 거래량이 우세하고 OBV가 개선되는 수급 개선 신호 찾아줘",
    description: "20일 상승·하락일 거래량과 OBV 방향을 함께 확인",
  },
  {
    label: "과거 급등 전 검증",
    command: "20일 안에 20% 이상 급등하기 직전에 거래량이 튀었던 날",
    description: "미래 가격을 쓰는 과거 검증 전용 조건",
  },
];
