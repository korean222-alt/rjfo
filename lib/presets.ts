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
};

/** UI 프리셋 칩 — 탭하면 명령창에 텍스트를 삽입한다. */
export const PRESET_CHIPS: { label: string; command: string }[] = [
  { label: "거래량 폭발", command: "20일 평균 대비 3배 이상 거래량이 터진 날 찾아줘" },
  { label: "매집 신호", command: "거래량이 늘지만 주가가 눌리고 수급이 누적된 매집 신호 찾아줘" },
  { label: "상승 전 압축", command: "변동성은 줄고 거래량과 종가 위치가 좋아지는 상승 전 압축 신호 찾아줘" },
  { label: "초기 돌파", command: "거래량이 늘면서 상승한 채 고가 부근에서 마감한 초기 돌파 신호 찾아줘" },
  { label: "과거 급등 전 검증", command: "20일 안에 20% 이상 급등하기 직전에 거래량이 튀었던 날" },
];
