import { METRICS, OPS, type FilterSpec, type Metric, type Op } from "@/types";
import { PRESET_CONDITIONS } from "./presets";

export class SpecValidationError extends Error {}

function isMetric(v: unknown): v is Metric {
  return typeof v === "string" && (METRICS as readonly string[]).includes(v);
}
function isOp(v: unknown): v is Op {
  return typeof v === "string" && (OPS as readonly string[]).includes(v);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** LLM 출력은 신뢰하지 않는다. 알려진 값만 통과시키고 나머지는 버린다. */
export function validateSpec(raw: unknown): FilterSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new SpecValidationError("JSON 객체가 아닙니다.");
  }
  const o = raw as Record<string, unknown>;

  const conditions = Array.isArray(o.conditions)
    ? o.conditions.flatMap((c) => {
        if (typeof c !== "object" || c === null) return [];
        const cc = c as Record<string, unknown>;
        const value = typeof cc.value === "number" ? cc.value : Number(cc.value);
        if (!isMetric(cc.metric) || !isOp(cc.op) || !isFinite(value)) return [];
        return [{ metric: cc.metric, op: cc.op, value }];
      })
    : [];

  const preset =
    typeof o.preset === "string" && o.preset in PRESET_CONDITIONS
      ? (o.preset as FilterSpec["preset"])
      : null;

  // preset만 오고 conditions가 비었으면 프리셋 정의로 채운다.
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
      // 과도한 창은 잘라낸다 (5년 데이터 기준)
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

/** 모델이 백틱이나 서문을 붙였을 때를 대비해 JSON 본문만 추출한다. */
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
