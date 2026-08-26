import { PRESET_CHIPS, PRESET_CONDITIONS } from "@/lib/presets";
import type { FilterSpec, MetricCondition } from "@/types";

const KO_NUM: Record<string, number> = {
  한: 1,
  두: 2,
  세: 3,
  네: 4,
  다섯: 5,
};

function numToken(raw: string | undefined): number | null {
  if (!raw) return null;
  if (KO_NUM[raw] != null) return KO_NUM[raw];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function fromChipLabel(command: string): FilterSpec | null {
  const chip = PRESET_CHIPS.find((c) => c.label === command || c.command === command);
  if (!chip) return null;
  return {
    conditions: chip.conditions,
    logic: "AND",
    preset: chip.preset,
    lookahead: chip.lookahead,
    interpretation: `${chip.label}: ${chip.hint}`,
    confidence: chip.lookahead ? "low" : "high",
  };
}

/** Gemini 없이 처리 가능한 짧은 한국어 명령. 애매하면 null. */
export function parseLocalCommand(command: string): FilterSpec | null {
  const s = command.trim();
  if (!s) return null;

  const labeled = fromChipLabel(s);
  if (labeled) return labeled;

  if (/거래량은?\s*(늘|터졌).{0,24}(주가|가격|종가).{0,16}안\s*움직/.test(s)) {
    return {
      conditions: PRESET_CONDITIONS.absorption,
      logic: "AND",
      preset: "absorption",
      interpretation: "거래량은 늘었는데 종가는 거의 안 움직인 날",
      confidence: "high",
    };
  }

  if (/고가.{0,8}(마감|근처|부근)|위쪽.{0,6}마감/.test(s) && /거래량/.test(s)) {
    return {
      conditions: PRESET_CONDITIONS.high_close,
      logic: "AND",
      preset: "high_close",
      interpretation: "거래량이 늘고 고가 근처에서 마감한 날",
      confidence: "high",
    };
  }

  if (/오르는\s*날.{0,12}거래량|누적\s*매집/.test(s)) {
    return {
      conditions: PRESET_CONDITIONS.accumulation,
      logic: "AND",
      preset: "accumulation",
      interpretation: "오르는 날에 거래량이 몰리는 날",
      confidence: "low",
    };
  }

  if (/펀딩/.test(s) && /과열|롱이\s*몰/.test(s)) {
    return {
      conditions: PRESET_CONDITIONS.funding_heat,
      logic: "AND",
      preset: "funding_heat",
      interpretation: "펀딩비가 과열(롱 지불)인 날",
      confidence: "high",
    };
  }

  const absVol = s.match(/(\d+(?:\.\d+)?)\s*(m|M|백만|천만)/);
  if (absVol && /거래량/.test(s)) {
    const n = Number(absVol[1]);
    if (Number.isFinite(n) && n > 0) {
      const unit = absVol[2].toLowerCase();
      const value = unit === "천만" ? n * 10_000_000 : n * 1_000_000;
      return {
        conditions: [{ metric: "volume", op: ">=", value }],
        logic: "AND",
        preset: null,
        interpretation: `거래량 ${value.toLocaleString("ko-KR")}주 이상인 날`,
        confidence: "high",
      };
    }
  }

  const ratio = s.match(
    /(?:평균|평소).{0,12}(\d+(?:\.\d+)?|두|세|네|다섯)\s*배|거래량.{0,20}(\d+(?:\.\d+)?|두|세|네|다섯)\s*배/,
  );
  if (ratio) {
    const value = numToken(ratio[1] || ratio[2]);
    if (value != null && value > 0) {
      const conditions: MetricCondition[] = [
        { metric: "volume_ratio_20d", op: ">=", value },
      ];
      if (/종가.{0,10}(오른|올랐|상승)|양봉/.test(s)) {
        conditions.push({ metric: "close_change_pct", op: ">", value: 0 });
      }
      return {
        conditions,
        logic: "AND",
        preset: null,
        interpretation:
          conditions.length === 1
            ? `거래량이 20일 평균의 ${value}배 이상인 날`
            : `거래량이 20일 평균의 ${value}배 이상이고 종가가 오른 날`,
        confidence: "high",
      };
    }
  }

  return null;
}
