import type { Condition, FilterSpec, PresetName } from "@/types";

export const PRESET_CONDITIONS: Record<PresetName, Condition[]> = {
  // 흡수형: 거래량은 늘었는데 주가는 거의 안 움직임
  absorption: [
    { metric: "volume_ratio_20d", op: ">=", value: 1.5 },
    { metric: "abs_close_change_pct", op: "<=", value: 3.0 },
  ],
  // 고가마감형: 거래량 증가 + 고가 쪽 마감
  high_close: [
    { metric: "volume_ratio_20d", op: ">=", value: 1.3 },
    { metric: "close_position_in_range", op: ">=", value: 0.7 },
  ],
  // 누적형: 오르는 날에 거래량이 몰림
  accumulation: [
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 1.2 },
    { metric: "obv_slope_20d", op: ">=", value: 0.1 },
  ],
};

/** 알림 등록에 쓰는 신호 키. lookahead 신호는 실시간 알림 대상이 아니다. */
export type SignalKey =
  | "volume_spike"
  | "absorption"
  | "high_close"
  | "accumulation"
  | "pre_surge";

export type PresetChip = {
  key: SignalKey;
  label: string;
  /** 한 줄 설명 — 수식이 아니라 사람 말로. */
  hint: string;
  command: string;
  conditions: Condition[];
  preset: PresetName | null;
  lookahead?: FilterSpec["lookahead"];
};

/**
 * 빠른 신호 — 탭하면 명령창이 그 문장으로 바뀌고, 아래 conditions가 그대로 쓰인다
 * (AI 해석을 거치지 않으므로 결과가 항상 같다).
 *
 * 임계값은 "가끔은 실제로 걸리는" 수준으로 잡는다. 너무 조이면 매칭이 0이 되어
 * 통계도 알림도 무의미해진다.
 */
export const PRESET_CHIPS: PresetChip[] = [
  {
    key: "volume_spike",
    label: "거래량 폭발",
    hint: "평소보다 거래량이 2배 넘게 터진 날",
    command: "평소보다 거래량이 2배 넘게 터진 날 찾아줘",
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 2.0 }],
    preset: null,
  },
  {
    key: "absorption",
    label: "물량 흡수",
    hint: "거래량은 늘었는데 주가는 거의 안 움직인 날",
    command: "거래량은 늘었는데 주가는 거의 안 움직인 날 찾아줘",
    conditions: PRESET_CONDITIONS.absorption,
    preset: "absorption",
  },
  {
    key: "high_close",
    label: "고가 마감",
    hint: "거래량 늘면서 그날 고가 근처에서 끝난 날",
    command: "거래량 늘면서 그날 고가 근처에서 끝난 날 찾아줘",
    conditions: PRESET_CONDITIONS.high_close,
    preset: "high_close",
  },
  {
    key: "accumulation",
    label: "누적 매집",
    hint: "오르는 날에 거래량이 몰리고 있는 구간",
    command: "오르는 날에 거래량이 몰리고 있는 날 찾아줘",
    conditions: PRESET_CONDITIONS.accumulation,
    preset: "accumulation",
  },
  {
    key: "pre_surge",
    label: "급등 직전",
    hint: "이후 20일 안에 크게 오른 날의 직전 거래량 (과거 검증용)",
    command: "20일 안에 크게 급등하기 직전에 거래량이 늘었던 날 찾아줘",
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 1.5 }],
    preset: null,
    lookahead: { days: 20, min_return_pct: 15 },
  },
];

export function findChip(key: string): PresetChip | null {
  return PRESET_CHIPS.find((c) => c.key === key) ?? null;
}

/** 알림으로 받을 수 있는 신호 — 미래를 보는 lookahead 신호는 제외한다. */
export const ALERT_SIGNALS: PresetChip[] = PRESET_CHIPS.filter((c) => !c.lookahead);
