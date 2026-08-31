/**
 * 캔들 리포트를 한국어 문장으로 옮긴다.
 *
 * Gemini가 죽어도 화면에는 항상 이 문장이 나온다. LLM은 이 문장을 다듬는 역할일 뿐,
 * 숫자를 만들어내는 자리가 아니다.
 */

import { HORIZON_LABEL } from "./evaluate";
import type { CandleReport } from "./index";

function pct(n: number | null | undefined, digits = 0): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}%`;
}

function signed(n: number | null | undefined, digits = 2): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function narrate(report: CandleReport): string {
  const lines: string[] = [];
  const base = report.baseline.byHorizon[String(report.horizon)];
  const span = HORIZON_LABEL[report.horizon] ?? `${report.horizon}거래일`;
  const last = report.read[report.read.length - 1];

  lines.push(
    `${report.ticker}의 ${report.periodStart}~${report.periodEnd}(${report.totalBars}봉)에서 ` +
      `캔들 패턴 ${report.patterns.length}가지를 채점했습니다. 기준선은 "아무 날이나 사면 ${span} 뒤 ` +
      `상승 확률 ${pct(base.upRate)}, 평균 ${signed(base.avg)}"입니다.`,
  );

  const aGrade = report.patterns.filter((p) => p.grade === "A");
  const bGrade = report.patterns.filter((p) => p.grade === "B");
  if (aGrade.length) {
    lines.push(
      `여섯 관문을 다 통과한 패턴은 ${aGrade.length}개입니다: ` +
        aGrade
          .slice(0, 4)
          .map(
            (p) =>
              `${p.label}(${p.count}회, 적중 ${pct(p.successRate)} vs 기저 ${pct(p.baseRate)}, 평균 ${signed(p.avgMovePct)})`,
          )
          .join(", ") +
        (aGrade.length > 4 ? " 외" : "") +
        ".",
    );
  } else if (bGrade.length) {
    const b = bGrade[0];
    lines.push(
      `여섯 관문을 다 통과한 패턴은 없습니다. 가장 가까운 건 ${b.label}(${b.passCount}/6, ${b.count}회, ` +
        `적중 ${pct(b.successRate)} vs 기저 ${pct(b.baseRate)})인데, 관문 하나를 못 넘었습니다: ` +
        b.checks.filter((c) => !c.ok).map((c) => c.label).join(", ") + ".",
    );
  } else {
    lines.push(
      "여섯 관문을 다 통과한 패턴은 없습니다. 이 종목·이 기간에서 '이 캔들이 뜨면 오른다'고 말할 " +
        "근거는 데이터에 없습니다.",
    );
  }

  if (last) {
    lines.push(
      `마지막 봉(${last.date})은 ${last.shape}입니다 — 등락 ${signed(last.changePct)}, ` +
        `몸통이 범위의 ${pct(last.bodyPct)}, 아랫꼬리 ${pct(last.lowerPct)}, 윗꼬리 ${pct(last.upperPct)}.`,
    );
  }

  lines.push(report.outlook.basis);

  if (report.outlook.usable.length) {
    lines.push(
      `다만 이건 과거 ${report.periodStart}~${report.periodEnd}에서 같은 모양 뒤에 벌어진 일의 평균일 뿐, ` +
        "이번에도 그렇게 된다는 뜻이 아닙니다.",
    );
  }

  lines.push(
    `표본이 겹치지 않는 발생 기준이고, 패턴 ${report.patterns.length}가지를 한꺼번에 검사한 걸 ` +
      "보정한 확률(q값)로 등급을 매겼습니다. 수수료·슬리피지는 빠져 있습니다.",
  );

  return lines.join(" ");
}
