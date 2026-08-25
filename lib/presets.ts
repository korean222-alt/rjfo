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

/** UI 프리셋 칩 — 초기 버전의 5개 명령을 그대로 유지한다. */
export const PRESET_CHIPS: { label: string; command: string }[] = [
  { label: "거래량 폭발", command: "20일 평균 대비 3배 이상 거래량이 터진 날 찾아줘" },
  { label: "물량 흡수", command: "거래량은 터졌는데 주가는 거의 안 움직인 날 찾아줘" },
  { label: "고가 마감", command: "거래량 늘면서 고가 부근에서 마감한 날 찾아줘" },
  { label: "급등 직전", command: "20일 안에 20% 이상 급등하기 직전에 거래량이 튀었던 날" },
  { label: "누적 매집", command: "세력이 매집한 것 같은 날 찾아줘" },
];
