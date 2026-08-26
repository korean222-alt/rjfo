import { METRICS, OPS, type Condition, type FilterSpec, type Metric, type Op } from "@/types";
import { clampPeriod, orderedPair } from "@/lib/ma";
import { PRESET_CONDITIONS } from "./presets";

export class SpecValidationError extends Error {}

function isMetric(v: unknown): v is Metric {
  return typeof v === "string" && (METRICS as readonly string[]).includes(v);
}
function isOp(v: unknown): v is Op {
  return typeof v === "string" && (OPS as readonly string[]).includes(v);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseCondition(c: unknown): Condition[] {
  if (typeof c !== "object" || c === null) return [];
  const cc = c as Record<string, unknown>;

  if (cc.kind === "ma_cross") {
    const pair = orderedPair(Number(cc.short), Number(cc.long));
    const direction = cc.direction === "death" ? "death" : "golden";
    return [{ kind: "ma_cross", short: pair.short, long: pair.long, direction }];
  }
  if (cc.kind === "ma_touch") {
    return [{ kind: "ma_touch", period: clampPeriod(Number(cc.period)) }];
  }

  const value = typeof cc.value === "number" ? cc.value : Number(cc.value);
  if (!isMetric(cc.metric) || !isOp(cc.op) || !isFinite(value)) return [];
  return [{ metric: cc.metric, op: cc.op, value }];
}

export function validateSpec(raw: unknown): FilterSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new SpecValidationError("JSON 객체가 아닙니다.");
  }
  const o = raw as Record<string, unknown>;

  const conditions = Array.isArray(o.conditions) ? o.conditions.flatMap(parseCondition) : [];

  const preset =
    typeof o.preset === "string" && o.preset in PRESET_CONDITIONS
      ? (o.preset as FilterSpec["preset"])
      : null;

  const finalConditions =
    conditions.length > 0 ? conditions : preset ? PRESET_CONDITIONS[preset] : [];

  if (finalConditions.length === 0) {
    throw new SpecValidationError("유효한 조건이 없습니다.");
  }

  let lookahead: FilterSpec["lookahead"];
  if (typeof o.lookahead === "object" && o.lookahead !== null) {
    const l = o.lookahead as Record<string, unknown>;
    const days = Number(l.days);
    const min = Number(l.min_return_pct);
    if (isFinite(days) && days > 0 && isFinite(min)) {
      lookahead = { days: Math.min(Math.round(days), 250), min_return_pct: min };
    }
  }

  let period: FilterSpec["period"];
  if (typeof o.period === "object" && o.period !== null) {
    const p = o.period as Record<string, unknown>;
    const start = typeof p.start === "string" && DATE_RE.test(p.start) ? p.start : undefined;
    const end = typeof p.end === "string" && DATE_RE.test(p.end) ? p.end : undefined;
    if (start || end) period = { start, end };
  }

  return {
    conditions: finalConditions,
    logic: o.logic === "OR" ? "OR" : "AND",
    lookahead,
    period,
    preset,
    interpretation:
      typeof o.interpretation === "string" && o.interpretation.trim()
        ? o.interpretation.trim()
        : "조건을 해석했습니다.",
    confidence: o.confidence === "high" ? "high" : "low",
  };
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) throw new SpecValidationError("JSON을 찾지 못했습니다.");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
