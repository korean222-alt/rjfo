/**
 * 성적표와 요약 카드가 같은 말을 하게 만드는 표시 헬퍼.
 *
 * 화면 두 곳에서 같은 숫자를 다른 색·다른 문구로 보여주면 그 순간부터 못 믿는다.
 * 등급 뱃지, 우연일 확률 색, 선행/후행 칩은 전부 여기 한 곳에서만 정의한다.
 */

import type { Grade } from "@/lib/cycle";
import { GRADE_LABEL } from "@/lib/cycle";

/** 20% 미만이면 초록불. 5% 미만은 굵게 — 한눈에 세 단계로 읽히게. */
export function chanceTone(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "text-muted";
  if (p < 0.05) return "font-semibold text-up";
  if (p < 0.2) return "text-up";
  return "text-down";
}

export function chancePct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  const pct = p * 100;
  if (pct < 0.1) return "0.1% 미만";
  return `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`;
}

/**
 * 보정 후 확률(q값)은 등급 관문이 10% 미만을 요구한다.
 * 우연일 확률(20% 미만 초록)과 같은 색 규칙을 쓰면 "초록불인데 관문 탈락"이 되어
 * 화면이 서로 다른 말을 한다. q값만 관문 기준으로 칠한다.
 */
export function qTone(q: number | null | undefined): string {
  if (q == null || !Number.isFinite(q)) return "text-muted";
  if (q < 0.05) return "font-semibold text-up";
  if (q < 0.1) return "text-up";
  if (q < 0.2) return "text-amber-300";
  return "text-down";
}

const GRADE_STYLE: Record<Grade, string> = {
  A: "border-up/60 bg-up/15 text-up",
  B: "border-sky-500/50 bg-sky-500/10 text-sky-300",
  C: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  D: "border-border bg-bg text-muted",
};

export function GradeBadge({ grade, passCount }: { grade: Grade; passCount?: number }) {
  return (
    <span
      title={`${GRADE_LABEL[grade]}${passCount != null ? ` · 관문 ${passCount}/6 통과` : ""}`}
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold ${GRADE_STYLE[grade]}`}
    >
      {grade}
      {passCount != null ? <span className="ml-1 font-normal opacity-80">{passCount}/6</span> : null}
    </span>
  );
}

/** 선행/동행/후행. 후행이라고 못 쓸 건 아니라서 색은 순한 쪽으로 쓴다. */
export function TimingChip({ timing }: { timing: "선행" | "동행" | "후행" | null }) {
  if (!timing) return null;
  const tone =
    timing === "선행" ? "text-up" : timing === "동행" ? "text-white" : "text-muted";
  return <span className={`shrink-0 text-[10px] ${tone}`}>{timing}</span>;
}

export function leadText(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return "—";
  if (days === 0) return "바닥 당일";
  return days > 0 ? `${days}일 늦게` : `${Math.abs(days)}일 먼저`;
}
