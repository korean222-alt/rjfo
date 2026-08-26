import {
  DEFAULT_LONG_MA,
  DEFAULT_SHORT_MA,
  DEFAULT_TOUCH_MA,
  maCrossCommand,
  maCrossSpec,
  maTouchCommand,
  maTouchSpec,
  orderedPair,
  clampPeriod,
  type MaParams,
} from "@/lib/ma";
import type { Condition, FilterSpec, PresetName } from "@/types";

export const PRESET_CONDITIONS: Record<PresetName, Condition[]> = {
  absorption: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.0 },
    { metric: "abs_close_change_pct", op: "<=", value: 2.0 },
  ],
  high_close: [
    { metric: "volume_ratio_20d", op: ">=", value: 1.8 },
    { metric: "close_position_in_range", op: ">=", value: 0.75 },
  ],
  accumulation: [
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 1.5 },
    { metric: "obv_slope_20d", op: ">=", value: 0.3 },
  ],
  squeeze: [
    { metric: "atr_ratio_20d", op: "<=", value: 0.8 },
    { metric: "volume_ratio_20d", op: ">=", value: 1.2 },
    { metric: "close_position_in_range", op: ">=", value: 0.6 },
  ],
  volume_expansion: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.5 },
    { metric: "volume_zscore_60d", op: ">=", value: 1.5 },
  ],
  strong_breakout: [
    { metric: "volume_ratio_20d", op: ">=", value: 2.0 },
    { metric: "close_change_pct", op: ">=", value: 2.0 },
    { metric: "close_position_in_range", op: ">=", value: 0.85 },
  ],
  flow_improvement: [
    { metric: "up_down_vol_ratio_20d", op: ">=", value: 1.4 },
    { metric: "obv_slope_20d", op: ">=", value: 0.15 },
  ],
};

export type SignalKey =
  | "volume_spike"
  | "absorption"
  | "high_close"
  | "pre_surge"
  | "accumulation"
  | "squeeze"
  | "strong_breakout"
  | "volume_expansion"
  | "flow_improvement"
  | "golden_cross"
  | "death_cross"
  | "ma_touch";

export type PresetChip = {
  key: SignalKey;
  label: string;
  hint: string;
  command: string;
  conditions: Condition[];
  preset: PresetName | null;
  lookahead?: FilterSpec["lookahead"];
};

const defaultGolden = maCrossSpec("golden");
const defaultDeath = maCrossSpec("death");
const defaultTouch = maTouchSpec();

export const PRESET_CHIPS: PresetChip[] = [
  {
    key: "volume_spike",
    label: "거래량 폭발",
    hint: "20일 평균 거래량 대비 3.0배 이상",
    command: "거래량 폭발: 20일 평균 대비 3.0배 이상 거래량인 날 찾아줘",
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 3.0 }],
    preset: null,
  },
  {
    key: "absorption",
    label: "물량 흡수",
    hint: "거래량 2.0배 이상 · 종가 변동 ±2.0% 이내",
    command: "물량 흡수: 20일 평균 대비 거래량 2.0배 이상이고 종가 변동이 ±2.0% 이내인 날 찾아줘",
    conditions: PRESET_CONDITIONS.absorption,
    preset: "absorption",
  },
  {
    key: "high_close",
    label: "고가 마감",
    hint: "거래량 1.8배 이상 · 당일 고저폭 상위 25% 마감",
    command: "고가 마감: 20일 평균 대비 거래량 1.8배 이상이고 당일 고저폭 상위 25%에서 마감한 날 찾아줘",
    conditions: PRESET_CONDITIONS.high_close,
    preset: "high_close",
  },
  {
    key: "pre_surge",
    label: "급등 직전",
    hint: "이후 20거래일 안에 +20% 이상 상승한 과거 검증",
    command: "급등 직전 검증: 이후 20거래일 안에 20% 이상 상승한 날의 직전 거래량 조건을 검증해줘",
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 2.0 }],
    preset: null,
    lookahead: { days: 20, min_return_pct: 20 },
  },
  {
    key: "accumulation",
    label: "누적 매집",
    hint: "상승·하락일 거래량 비율 1.5 이상 · OBV 20일 기울기 0.3 이상",
    command:
      "누적 매집: 최근 20일 상승일 거래량 합이 하락일 거래량 합의 1.5배 이상이고 OBV 20일 기울기가 0.3 이상인 날 찾아줘",
    conditions: PRESET_CONDITIONS.accumulation,
    preset: "accumulation",
  },
  {
    key: "squeeze",
    label: "상승 전 압축",
    hint: "ATR 비율 0.8 이하 · 거래량 1.2배 이상 · 고저폭 상위 40% 마감",
    command:
      "상승 전 압축: ATR(14)가 20일 평균 ATR의 0.8배 이하이고 거래량이 20일 평균의 1.2배 이상이며 종가가 당일 고저폭 상위 40%에서 마감한 날 찾아줘",
    conditions: PRESET_CONDITIONS.squeeze,
    preset: "squeeze",
  },
  {
    key: "strong_breakout",
    label: "강한 돌파",
    hint: "거래량 2.0배 이상 · +2.0% 이상 · 고저폭 상위 15% 마감",
    command:
      "강한 돌파: 20일 평균 대비 거래량 2.0배 이상이고 종가가 2.0% 이상 상승하며 당일 고저폭 상위 15%에서 마감한 날 찾아줘",
    conditions: PRESET_CONDITIONS.strong_breakout,
    preset: "strong_breakout",
  },
  {
    key: "volume_expansion",
    label: "거래량 확장",
    hint: "거래량 2.5배 이상 · 60일 z-score 1.5 이상",
    command: "거래량 확장: 20일 평균 대비 거래량 2.5배 이상이고 60일 거래량 z-score가 1.5 이상인 날 찾아줘",
    conditions: PRESET_CONDITIONS.volume_expansion,
    preset: "volume_expansion",
  },
  {
    key: "flow_improvement",
    label: "수급 개선",
    hint: "상승·하락일 거래량 비율 1.4 이상 · OBV 20일 기울기 0.15 이상",
    command:
      "수급 개선: 최근 20일 상승일 거래량 합이 하락일 거래량 합의 1.4배 이상이고 OBV 20일 기울기가 0.15 이상인 날 찾아줘",
    conditions: PRESET_CONDITIONS.flow_improvement,
    preset: "flow_improvement",
  },
  {
    key: "golden_cross",
    label: "골든크로스",
    hint: `단기선이 장기선을 위로 돌파 (기본 ${DEFAULT_SHORT_MA}/${DEFAULT_LONG_MA})`,
    command: maCrossCommand("golden"),
    conditions: defaultGolden.conditions,
    preset: null,
  },
  {
    key: "death_cross",
    label: "데드크로스",
    hint: `단기선이 장기선을 아래로 관통 (기본 ${DEFAULT_SHORT_MA}/${DEFAULT_LONG_MA})`,
    command: maCrossCommand("death"),
    conditions: defaultDeath.conditions,
    preset: null,
  },
  {
    key: "ma_touch",
    label: "이평선 터치",
    hint: `가격이 이동평균선에 닿는 날 (기본 ${DEFAULT_TOUCH_MA}일)`,
    command: maTouchCommand(),
    conditions: defaultTouch.conditions,
    preset: null,
  },
];

export function findChip(key: string): PresetChip | null {
  return PRESET_CHIPS.find((c) => c.key === key) ?? null;
}

export const ALERT_SIGNALS: PresetChip[] = PRESET_CHIPS.filter((c) => !c.lookahead);

export function isMaSignal(key: string): key is "golden_cross" | "death_cross" | "ma_touch" {
  return key === "golden_cross" || key === "death_cross" || key === "ma_touch";
}

export function normalizeMaParams(signal: SignalKey, raw?: MaParams | null): MaParams | undefined {
  if (signal === "golden_cross" || signal === "death_cross") {
    const pair = orderedPair(raw?.short ?? DEFAULT_SHORT_MA, raw?.long ?? DEFAULT_LONG_MA);
    return { short: pair.short, long: pair.long };
  }
  if (signal === "ma_touch") {
    return { period: clampPeriod(raw?.period ?? raw?.short ?? DEFAULT_TOUCH_MA) };
  }
  return undefined;
}

export function specForSignal(signal: SignalKey, params?: MaParams | null): FilterSpec | null {
  const chip = findChip(signal);
  if (!chip || chip.lookahead) return null;

  if (signal === "golden_cross" || signal === "death_cross") {
    const pair = orderedPair(params?.short ?? DEFAULT_SHORT_MA, params?.long ?? DEFAULT_LONG_MA);
    return maCrossSpec(signal === "death_cross" ? "death" : "golden", pair.short, pair.long);
  }
  if (signal === "ma_touch") {
    return maTouchSpec(params?.period ?? params?.short ?? DEFAULT_TOUCH_MA);
  }

  return {
    conditions: chip.conditions,
    logic: "AND",
    preset: chip.preset,
    lookahead: chip.lookahead,
    interpretation: chip.label,
    confidence: "high",
  };
}

export function labelForWatch(signal: SignalKey, params?: MaParams | null): string {
  const chip = findChip(signal);
  const base = chip?.label ?? signal;
  const normalized = normalizeMaParams(signal, params);
  if (!normalized) return base;
  if (normalized.period) return `${base} (${normalized.period}일)`;
  if (normalized.short && normalized.long) return `${base} (${normalized.short}/${normalized.long})`;
  return base;
}
