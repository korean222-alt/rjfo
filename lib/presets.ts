import type { Condition, PresetName } from "@/types";

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
  // 누적형: 상승일에 거래량이 몰림
  accumulation: [
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 1.5 },
    { metric: "obv_slope_20d", op: ">=", value: 0.3 },
  ],
};

/** UI 프리셋 칩 — 탭하면 명령창에 텍스트를 삽입한다. */
export const PRESET_CHIPS: { label: string; command: string }[] = [
  { label: "거래량 폭발", command: "20일 평균 대비 3배 이상 거래량이 터진 날 찾아줘" },
  { label: "물량 흡수", command: "거래량은 터졌는데 주가는 거의 안 움직인 날 찾아줘" },
  { label: "고가 마감", command: "거래량 늘면서 고가 부근에서 마감한 날 찾아줘" },
  { label: "급등 직전", command: "20일 안에 20% 이상 급등하기 직전에 거래량이 튀었던 날" },
  { label: "누적 매집", command: "세력이 매집한 것 같은 날 찾아줘" },
];
