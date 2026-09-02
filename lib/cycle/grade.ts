/**
 * "이 신호 뜨면 사도 되나"를 등급으로.
 *
 * 지표 하나를 볼 때 사람이 실제로 묻는 건 적중률이 아니라 이거다. 그런데 적중률·우연대비·
 * 수익률을 따로 늘어놓으면 어느 쪽을 봐야 할지 알 수 없다. 그래서 관문을 여섯 개로 정하고,
 * 몇 개를 통과했는지로 등급을 매긴다. 각 관문은 통과/탈락이 눈에 보이게 그대로 내보낸다
 * (점수 하나로 뭉개면 왜 A인지 알 수 없고, 그러면 또 못 믿는다).
 *
 * 관문은 전부 "이걸 못 넘으면 사면 안 되는 이유"에서 왔다:
 *   우연 아님   — 지표를 수십 개 재면 그중 몇 개는 우연히 좋아 보인다. 그걸 걸러낸다.
 *   우연대비    — 아무 날이나 찍은 것보다 상승장 시작을 더 자주 가리켰나.
 *   기저율 초과 — 신호 후 1년 수익률이 '아무 날이나 산 것'보다 높았나. 우상향 자산은
 *                아무 날이나 사도 1년 뒤 오르므로, 이걸 안 빼면 전부 좋아 보인다.
 *   꾸준함      — 앞 기간에서도 뒤 기간에서도 통했나. 옛날 한 번의 대박이 아닌지.
 *   적중률      — 과거 상승장 시작을 절반 이상 잡았나.
 *   남은 상승   — 늦게 떠도 좋다. 다만 신호가 떴을 때 상승분이 절반 이상 남아 있어야 한다.
 */

import type { SignalEvaluation } from "./evaluate";

export type GradeCheck = {
  label: string;
  ok: boolean;
  /** 통과/탈락의 근거가 된 실제 값. */
  detail: string;
};

export type Grade = "A" | "B" | "C" | "D";

export type GradedSignal = SignalEvaluation & {
  /**
   * 다중검정 보정 후 확률 (Benjamini-Hochberg q값).
   *
   * 지표를 30개 재면 '우연일 확률 5% 미만'짜리가 아무 의미 없이도 1~2개 나온다.
   * q값은 "이 지표를 유의하다고 선언했을 때, 그런 선언들 중 헛것이 섞여 있을 비율"이다.
   * 원래 p값보다 항상 크거나 같다. 화면에서 믿을지 말지는 이쪽으로 판단해야 한다.
   */
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

/**
 * Benjamini-Hochberg 보정.
 *
 * p값을 오름차순으로 세우고 i번째에 m/i를 곱한다. 뒤에서부터 최소값을 끌고 내려와
 * 단조성을 맞춘다(q값은 p 순서를 뒤집으면 안 된다). p를 못 잰 지표는 그대로 null.
 */
export function fdrQValues(pValues: (number | null)[]): (number | null)[] {
  const idx = pValues
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: number; i: number } => x.p != null && Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p);

  const m = idx.length;
  const out: (number | null)[] = pValues.map(() => null);
  if (!m) return out;

  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = idx[rank - 1];
    running = Math.min(running, Math.min(1, (p * m) / rank));
    out[i] = running;
  }
  return out;
}

const pct = (v: number | null | undefined, digits = 0): string =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;

export function gradeSignal(s: SignalEvaluation, qValue: number | null): GradedSignal {
  const checks: GradeCheck[] = [
    {
      label: "우연이 아님",
      ok: qValue != null && qValue < 0.1,
      detail:
        qValue == null
          ? "신호가 없어 못 잼"
          : `지표를 한꺼번에 검사한 걸 감안한 확률 ${(qValue * 100).toFixed(qValue < 0.1 ? 1 : 0)}%`,
    },
    {
      label: "아무 날보다 자주 가리킴",
      ok: s.lift != null && s.lift >= 1.5,
      detail: s.lift == null ? "못 잼" : `우연대비 ${s.lift.toFixed(1)}배`,
    },
    {
      label: "그냥 사는 것보다 나음",
      ok: s.edge != null && s.edge > 0,
      detail: s.edge == null ? "못 잼" : `기저대비 ${s.edge >= 0 ? "+" : ""}${s.edge.toFixed(0)}%p`,
    },
    {
      label: "앞뒤 기간 모두 통함",
      ok: s.walkForward?.heldUp === true,
      detail: s.walkForward
        ? `${s.walkForward.splitDate} 기준 앞 ${s.walkForward.early.hits}/${s.walkForward.early.cycles} · 뒤 ${s.walkForward.late.hits}/${s.walkForward.late.cycles}`
        : "사이클이 적어 못 나눔",
    },
    {
      label: "절반 이상 잡음",
      ok: s.hitRate != null && s.hitRate >= 50,
      // 분모를 같이 적는다. 펀딩비처럼 값이 최근 몇 년치뿐인 지표는 사이클 두어 번으로만
      // 채점된 적중률이라, 전 기간을 본 지표의 적중률과 같은 무게로 읽으면 안 된다.
      detail:
        `적중률 ${pct(s.hitRate)} (${s.hitCount}/${s.coverage.cyclesCovered}번)` +
        (s.coverage.full
          ? ""
          : ` — 이 지표는 ${s.coverage.fromDate}부터만 값이 있어 사이클 ${s.coverage.cyclesTotal}번 중 ${s.coverage.cyclesCovered}번만 채점했습니다`),
    },
    {
      label: "떴을 때 상승분이 남아 있음",
      ok: s.medianCaptureSharePct != null && s.medianCaptureSharePct >= 50,
      detail: `남은 상승 ${pct(s.medianCaptureSharePct)}`,
    },
  ];

  const passCount = checks.filter((c) => c.ok).length;
  const grade: Grade = passCount >= 6 ? "A" : passCount === 5 ? "B" : passCount >= 3 ? "C" : "D";
  return { ...s, qValue, grade, checks, passCount };
}

/** 리스트 전체를 한 번에. q값은 리스트 안에서만 의미가 있으므로 따로 못 부른다. */
export function gradeSignals(list: SignalEvaluation[]): GradedSignal[] {
  const q = fdrQValues(list.map((s) => s.chance));
  return list.map((s, i) => gradeSignal(s, q[i]));
}
