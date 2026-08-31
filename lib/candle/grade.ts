/**
 * "이 캔들이 뜨면 진짜 오르나"를 등급으로.
 *
 * 캔들 패턴은 이 앱에서 가장 위험한 주제다. 책과 유튜브가 이미 "망치형이면 반등"이라고
 * 수천 번 말했고, 사용자는 그 말을 확인받고 싶어서 여기 온다. 그래서 관문을 넉넉히
 * 두지 않으면 이 화면은 통설에 도장만 찍어주는 기계가 된다.
 *
 * 상승장 지표와 같은 여섯 관문 구조를 쓰되, 묻는 질문이 다르다:
 *   표본        — 몇 번이나 나온 패턴인가. 다섯 번 나와 세 번 맞은 건 통계가 아니다.
 *   우연 아님   — 패턴 30가지를 한꺼번에 재면 그중 몇 개는 우연히 좋아 보인다.
 *   적중률 초과 — 아무 날이나 산 것보다 더 자주 맞혔나.
 *   수익 초과   — 아무 날이나 산 것보다 더 벌었나. (적중률만 높고 이건 음수인 패턴이
 *                 실제로 있다 — 자주 조금 먹고 가끔 크게 잃는 모양이다.)
 *   꾸준함      — 앞 기간에서도 뒤 기간에서도 통했나.
 *   덜 물림     — 들고 가는 동안의 역행폭이 평소보다 얕았나.
 */

import { fdrQValues } from "@/lib/cycle/grade";
import type { PatternEvaluation } from "./evaluate";

export type GradeCheck = {
  label: string;
  ok: boolean;
  detail: string;
};

export type Grade = "A" | "B" | "C" | "D";

export type GradedPattern = PatternEvaluation & {
  /** 다중검정 보정 후 확률 (Benjamini-Hochberg q값). 판단은 이걸로 한다. */
  qValue: number | null;
  grade: Grade;
  checks: GradeCheck[];
  passCount: number;
};

export const GRADE_LABEL: Record<Grade, string> = {
  A: "근거 있음",
  B: "쓸 만함",
  C: "약함",
  D: "근거 없음",
};

/** 이항 검정이 의미를 가지려면 최소 이만큼은 나와야 한다고 본 값. */
export const MIN_SAMPLE = 20;
/** 적중률이 기저보다 이만큼(%p)은 높아야 '더 자주 맞혔다'고 부른다. */
export const MIN_RATE_EDGE = 3;

const pct = (v: number | null | undefined, digits = 0): string =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;

const pp = (v: number | null | undefined, digits = 1): string =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%p`;

const sign = (v: number | null | undefined, digits = 2): string =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

export function gradePattern(p: PatternEvaluation, qValue: number | null): GradedPattern {
  const checks: GradeCheck[] = [
    {
      label: "표본이 충분함",
      ok: p.independentCount >= MIN_SAMPLE,
      detail: `겹치지 않는 발생 ${p.independentCount}회 (전체 ${p.count}회)`,
    },
    {
      label: "우연이 아님",
      ok: qValue != null && qValue < 0.1,
      detail:
        qValue == null
          ? "발생이 없어 못 잼"
          : `패턴을 한꺼번에 검사한 걸 감안한 확률 ${(qValue * 100).toFixed(qValue < 0.1 ? 1 : 0)}%`,
    },
    {
      label: "아무 날보다 자주 맞음",
      ok: p.rateEdge != null && p.rateEdge >= MIN_RATE_EDGE,
      detail:
        p.rateEdge == null
          ? "못 잼"
          : `적중률 ${pct(p.successRate)} vs 기저 ${pct(p.baseRate)} (${pp(p.rateEdge)})`,
    },
    {
      // 하락형에 "더 범"이라고 쓰면 거짓말이 된다. 하락형이 통과했다는 건
      // '그 뒤로 평소보다 덜 올랐다(또는 더 내렸다)'는 뜻이다.
      label: p.bias === "상승" ? "그냥 산 것보다 더 범" : "평소보다 더 내림",
      ok: p.edge != null && p.edge > 0,
      detail:
        p.edge == null
          ? "못 잼"
          : `평균 ${sign(p.avgMovePct)} vs 기저 ${sign(p.baseAvgMovePct)} → 방향 대비 ${pp(p.edge, 2)}`,
    },
    {
      label: "앞뒤 기간 모두 통함",
      ok: p.walkForward?.heldUp === true,
      detail: p.walkForward
        ? `${p.walkForward.splitDate} 기준 앞 ${pp(p.walkForward.early.edge, 1)}(${p.walkForward.early.count}회) · 뒤 ${pp(p.walkForward.late.edge, 1)}(${p.walkForward.late.count}회)`
        : "발생이 적어 기간을 못 나눔",
    },
    {
      label: "평소보다 덜 물림",
      ok:
        p.adverse.medianPct != null &&
        p.baseAdverseMedianPct != null &&
        p.adverse.medianPct >= p.baseAdverseMedianPct,
      detail:
        p.adverse.medianPct == null
          ? "못 잼"
          : `역행폭 중앙값 ${pct(p.adverse.medianPct, 1)} vs 평소 ${pct(p.baseAdverseMedianPct, 1)}`,
    },
  ];

  const passCount = checks.filter((c) => c.ok).length;
  const grade: Grade = passCount >= 6 ? "A" : passCount === 5 ? "B" : passCount >= 3 ? "C" : "D";
  return { ...p, qValue, grade, checks, passCount };
}

/** 리스트 전체를 한 번에. q값은 '한꺼번에 몇 개를 쟀느냐'에 달려 있어 따로 못 부른다. */
export function gradePatterns(list: PatternEvaluation[]): GradedPattern[] {
  const q = fdrQValues(list.map((p) => p.chance));
  return list.map((p, i) => gradePattern(p, q[i]));
}
