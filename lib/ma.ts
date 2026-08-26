import type { Condition, EnrichedBar, FilterSpec } from "@/types";
import { smaValue } from "@/lib/indicators";

export const DEFAULT_SHORT_MA = 20;
export const DEFAULT_LONG_MA = 60;
export const DEFAULT_TOUCH_MA = 20;
export const DEFAULT_BREAKOUT_MA = 200;
export const MAX_MA_PERIOD = 500;

export type MaParams = {
  short?: number;
  long?: number;
  period?: number;
};

export function clampPeriod(n: number, fallback = DEFAULT_SHORT_MA): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_MA_PERIOD, Math.max(2, Math.round(n)));
}

export function orderedPair(short: number, long: number): { short: number; long: number } {
  let a = clampPeriod(short, DEFAULT_SHORT_MA);
  let b = clampPeriod(long, DEFAULT_LONG_MA);
  if (a === b) b = Math.min(MAX_MA_PERIOD, a + 1);
  if (a > b) [a, b] = [b, a];
  return { short: a, long: b };
}

export function maCrossCommand(direction: "golden" | "death", short = DEFAULT_SHORT_MA, long = DEFAULT_LONG_MA): string {
  const pair = orderedPair(short, long);
  return `이평 ${pair.short}/${pair.long} ${direction === "golden" ? "골든크로스" : "데드크로스"}`;
}

export function maTouchCommand(period = DEFAULT_TOUCH_MA): string {
  return `이평 ${clampPeriod(period, DEFAULT_TOUCH_MA)} 터치`;
}

export function maCrossSpec(
  direction: "golden" | "death",
  short = DEFAULT_SHORT_MA,
  long = DEFAULT_LONG_MA,
): FilterSpec {
  const pair = orderedPair(short, long);
  const label = direction === "golden" ? "골든크로스" : "데드크로스";
  const verb = direction === "golden" ? "위로 돌파한" : "아래로 뚫은";
  return {
    conditions: [{ kind: "ma_cross", short: pair.short, long: pair.long, direction }],
    logic: "AND",
    preset: null,
    interpretation: `${pair.short}일선이 ${pair.long}일선을 ${verb} ${label}`,
    confidence: "high",
  };
}

export function maTouchSpec(period = DEFAULT_TOUCH_MA): FilterSpec {
  const p = clampPeriod(period, DEFAULT_TOUCH_MA);
  return {
    conditions: [{ kind: "ma_touch", period: p }],
    logic: "AND",
    preset: null,
    interpretation: `가격이 ${p}일 이동평균선에 닿은 날`,
    confidence: "high",
  };
}

export function maBreakoutSpec(
  period = DEFAULT_BREAKOUT_MA,
  direction: "up" | "down" = "up",
): FilterSpec {
  const p = clampPeriod(period, DEFAULT_BREAKOUT_MA);
  const way = direction === "down" ? "하향" : "상향";
  return {
    conditions: [{ kind: "ma_breakout", period: p, direction }],
    logic: "AND",
    preset: null,
    interpretation: `종가가 ${p}일선을 ${way} 돌파한 날`,
    confidence: "high",
  };
}

export function parseMaCommand(command: string): FilterSpec | null {
  const s = command.trim();
  if (!s) return null;

  const pairCmd = s.match(/^이평\s*(\d+)\s*[/,]\s*(\d+)\s*(골든크로스|데드크로스)$/);
  if (pairCmd) {
    return maCrossSpec(pairCmd[3].startsWith("골든") ? "golden" : "death", Number(pairCmd[1]), Number(pairCmd[2]));
  }

  const touchCmd = s.match(/^이평\s*(\d+)\s*(?:선\s*)?(?:터치|닿음?)$/);
  if (touchCmd) return maTouchSpec(Number(touchCmd[1]));

  const pairLoose = s.match(
    /(\d+)\s*일(?:선|이동평균선?)?\s*(?:과|이|,|\/)?\s*(\d+)\s*일(?:선|이동평균선?).{0,16}(골든|데드)/,
  );
  if (pairLoose) {
    return maCrossSpec(pairLoose[3].startsWith("골든") ? "golden" : "death", Number(pairLoose[1]), Number(pairLoose[2]));
  }

  if (/(골든크로스|데드크로스)/.test(s) && /이평|이동평균|일선/.test(s)) {
    const nums = [...s.matchAll(/(\d+)\s*일/g)].map((m) => Number(m[1]));
    const direction: "golden" | "death" = /데드/.test(s) ? "death" : "golden";
    if (nums.length >= 2) return maCrossSpec(direction, nums[0], nums[1]);
    return maCrossSpec(direction);
  }

  if (s === "골든크로스") return maCrossSpec("golden");
  if (s === "데드크로스") return maCrossSpec("death");

  // 종가 vs 이평선 돌파. Gemini로 넘기면 모델 체인 타임아웃으로 502가 난다.
  // "강한 돌파"(거래량 칩)는 이평/일선이 없어서 여기 안 걸린다.
  if (/돌파/.test(s) && /(\d+)\s*일|이평|이동평균|\bma\b/i.test(s) && !/(골든|데드)/.test(s)) {
    const dayNums = [...s.matchAll(/(\d+)\s*일/g)].map((m) => Number(m[1]));
    const maNum = s.match(/ma\s*(\d+)/i);
    const period = dayNums[0] ?? (maNum ? Number(maNum[1]) : DEFAULT_BREAKOUT_MA);
    const direction: "up" | "down" = /하향|아래/.test(s) ? "down" : "up";
    return maBreakoutSpec(period, direction);
  }

  const touchLoose = s.match(/(\d+)\s*일(?:선|이동평균선?)?\s*(?:에\s*)?(?:터치|닿)/);
  if (touchLoose) return maTouchSpec(Number(touchLoose[1]));

  if (/이평선?\s*(?:에\s*)?(?:터치|닿)|이동평균선?\s*(?:에\s*)?(?:터치|닿)/.test(s)) {
    const nums = [...s.matchAll(/(\d+)\s*일/g)].map((m) => Number(m[1]));
    return maTouchSpec(nums[0] ?? DEFAULT_TOUCH_MA);
  }

  return null;
}

export function closesOf(bars: { close: number }[]): number[] {
  return bars.map((b) => b.close);
}

export function isGoldenCross(bars: EnrichedBar[], i: number, short: number, long: number): boolean {
  if (i < 1) return false;
  const closes = closesOf(bars);
  const shortPrev = smaValue(closes, i - 1, short);
  const longPrev = smaValue(closes, i - 1, long);
  const shortNow = smaValue(closes, i, short);
  const longNow = smaValue(closes, i, long);
  if (shortPrev == null || longPrev == null || shortNow == null || longNow == null) return false;
  return shortPrev <= longPrev && shortNow > longNow;
}

export function isDeathCross(bars: EnrichedBar[], i: number, short: number, long: number): boolean {
  if (i < 1) return false;
  const closes = closesOf(bars);
  const shortPrev = smaValue(closes, i - 1, short);
  const longPrev = smaValue(closes, i - 1, long);
  const shortNow = smaValue(closes, i, short);
  const longNow = smaValue(closes, i, long);
  if (shortPrev == null || longPrev == null || shortNow == null || longNow == null) return false;
  return shortPrev >= longPrev && shortNow < longNow;
}

export function isMaTouch(bars: EnrichedBar[], i: number, period: number): boolean {
  if (i < 1) return false;
  const closes = closesOf(bars);
  const prev = smaValue(closes, i - 1, period);
  const now = smaValue(closes, i, period);
  if (prev == null || now == null) return false;
  const awayYesterday = bars[i - 1].high < prev || bars[i - 1].low > prev;
  const hitToday = bars[i].low <= now && bars[i].high >= now;
  return awayYesterday && hitToday;
}

export function isMaBreakout(
  bars: EnrichedBar[],
  i: number,
  period: number,
  direction: "up" | "down",
): boolean {
  if (i < 1) return false;
  const closes = closesOf(bars);
  const prev = smaValue(closes, i - 1, period);
  const now = smaValue(closes, i, period);
  if (prev == null || now == null) return false;
  if (direction === "down") {
    return bars[i - 1].close >= prev && bars[i].close < now;
  }
  return bars[i - 1].close <= prev && bars[i].close > now;
}

export function testMaCondition(bars: EnrichedBar[], i: number, c: Condition): boolean | null {
  if (c.kind === "ma_cross") {
    return c.direction === "death"
      ? isDeathCross(bars, i, c.short, c.long)
      : isGoldenCross(bars, i, c.short, c.long);
  }
  if (c.kind === "ma_touch") {
    return isMaTouch(bars, i, c.period);
  }
  if (c.kind === "ma_breakout") {
    return isMaBreakout(bars, i, c.period, c.direction);
  }
  return null;
}

export function periodsFromSpec(spec: FilterSpec): number[] {
  const out = new Set<number>();
  for (const c of spec.conditions ?? []) {
    if (c.kind === "ma_cross") {
      out.add(c.short);
      out.add(c.long);
    } else if (c.kind === "ma_touch" || c.kind === "ma_breakout") {
      out.add(c.period);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function smaLine(closes: { date: string; close: number }[], period: number): { date: string; value: number }[] {
  const values = closes.map((c) => c.close);
  const out: { date: string; value: number }[] = [];
  for (let i = 0; i < closes.length; i++) {
    const v = smaValue(values, i, period);
    if (v != null) out.push({ date: closes[i].date, value: v });
  }
  return out;
}
