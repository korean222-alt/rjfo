/**
 * 리포트를 한국어 문장으로 옮긴다.
 *
 * Gemini가 죽어도 화면에는 항상 이 문장이 나온다. LLM은 이 문장을 다듬는 역할일 뿐,
 * 숫자를 만들어내는 자리가 아니다.
 */

import type { CycleReport } from "./index";

function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "" : ""}${n.toFixed(digits)}%`;
}

function signed(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

export function narrate(report: CycleReport): string {
  const { cycles, signals, thresholds } = report;
  const lines: string[] = [];

  if (!cycles.length) {
    return (
      `${report.ticker}는 ${report.periodStart}~${report.periodEnd} 동안 ` +
      `기준(고점 대비 -${thresholds.bearPct}% 하락 후 저점 대비 +${thresholds.bullPct}% 반등)을 만족하는 ` +
      `상승장 전환이 없었습니다. 데이터 기간이 짧거나 기준이 이 종목에 비해 빡빡합니다.`
    );
  }

  lines.push(
    `${report.ticker}는 ${report.periodStart}~${report.periodEnd}(약 ${report.years.toFixed(1)}년) 동안 ` +
      `상승장 전환이 ${cycles.length}번 있었습니다: ` +
      cycles.map((c) => `${c.troughDate}(이후 ${signed(c.gainPct, 0)}%)`).join(", ") +
      ".",
  );

  const common = signals.filter((s) => report.commonKeys.includes(s.key));
  if (common.length) {
    lines.push(
      `그 ${cycles.length}번을 전부 가리킨 지표는 ${common.length}개입니다: ` +
        common.slice(0, 6).map((s) => s.label).join(", ") +
        (common.length > 6 ? " 외" : "") +
        ".",
    );
  } else {
    lines.push(`모든 전환을 빠짐없이 잡은 지표는 없었습니다.`);
  }

  const best = signals[0];
  if (best) {
    const lead =
      best.medianLeadDays == null
        ? "리드타임 미상"
        : best.medianLeadDays >= 0
          ? `바닥보다 중앙값 ${best.medianLeadDays}거래일 늦게`
          : `바닥보다 중앙값 ${Math.abs(best.medianLeadDays)}거래일 먼저`;
    lines.push(
      `종합 1위는 "${best.label}"입니다. ${cycles.length}번 중 ${best.hitCount}번 적중, ${lead} 떴고, ` +
        `그 시점에 그 사이클 상승분의 ${pct(best.medianCaptureSharePct)}가 아직 남아 있었습니다.`,
    );
    if (best.lift != null) {
      lines.push(
        best.lift >= 1
          ? `이 지표의 신호는 아무 날이나 찍었을 때보다 상승장 시작을 ${best.lift.toFixed(1)}배 자주 가리켰습니다.`
          : `다만 아무 날이나 찍는 것보다 나을 게 없습니다(우연대비 ${best.lift.toFixed(2)}배).`,
      );
    }
    const base = report.baseline["250"].avg;
    lines.push(
      `신호 이후 1년 평균 수익률은 ${signed(best.forward["250"].avg)}%, ` +
        `같은 종목 아무 날이나 골랐을 때는 ${signed(base)}% — 차이 ${signed(best.edge)}%p입니다.`,
    );
  }

  const avgAtStart = report.cycleStarts.length
    ? report.cycleStarts.reduce((a, c) => a + c.on, 0) / report.cycleStarts.length
    : null;
  lines.push(
    `현재는 ${report.regime.phase} 국면이고 지표 ${report.now.total}개 중 ${report.now.on}개가 켜져 있습니다.` +
      (avgAtStart != null
        ? ` 과거 상승장 시작 30거래일 뒤에는 평균 ${avgAtStart.toFixed(1)}개가 켜져 있었습니다.`
        : ""),
  );

  return lines.join(" ");
}
