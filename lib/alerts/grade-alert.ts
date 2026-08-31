import type { CycleReport } from "@/lib/cycle";
import type { GradedSignal } from "@/lib/cycle/grade";
import { isCombo } from "@/lib/cycle/combos";

/**
 * "사도 될 근거가 있는 신호(A등급)가 새로 켜졌다"를 골라낸다.
 *
 * 왜 A등급만인가: 성적표에는 지표 30개와 조합 수십 개가 있고, 그중 대부분은 켜졌다는
 * 사실만으로는 아무 뜻이 없다. 여섯 관문(우연 아님 · 아무 날보다 자주 가리킴 ·
 * 그냥 사는 것보다 나음 · 앞뒤 기간 모두 통함 · 절반 이상 잡음 · 상승분 남아 있음)을
 * 다 통과한 것만 알림으로 보낸다. 알림이 하루가 멀다 하고 오면 그 순간부터 아무도
 * 안 본다 — 알림의 가치는 희소성에서 온다.
 *
 * 언제 보내는가: 그 신호가 '방금 켜졌을' 때만이다. 켜져 있는 동안 매일 보내면 소용없고,
 * 켜진 날짜까지 중복 키에 넣어 두므로 같은 점등으로 두 번 오지 않는다.
 */

/** 신호가 뜬 지 이만큼(거래일) 안이면 아직 '새로 켜진' 것으로 본다. */
export const FRESH_DAYS = 3;

export type GradeHit = {
  key: string;
  label: string;
  /** 단일 지표인가, 두 지표를 겹친 조합인가. */
  kind: "지표" | "조합";
  eventDate: string;
  daysSince: number;
  passCount: number;
  hitCount: number;
  /** 적중률의 분모 = 이 지표로 채점할 수 있었던 사이클 수. */
  cycles: number;
  /** 값이 있는 기간이 짧아 일부 사이클만 채점했으면 그 시작일. 전 기간이면 null. */
  partialFrom: string | null;
  lift: number | null;
  qValue: number | null;
  captureSharePct: number | null;
  medianLeadDays: number | null;
  worstDrawdownPct: number | null;
  /** 중복 방지 키. 같은 점등은 한 번만 보낸다. */
  dedupeKey: string;
};

function toHit(s: GradedSignal, cycles: number): GradeHit | null {
  if (s.grade !== "A") return null;
  if (s.currentlyOn !== true) return null;
  if (s.lastEventDate == null || s.daysSinceLastEvent == null) return null;
  if (s.daysSinceLastEvent > FRESH_DAYS) return null;

  return {
    key: s.key,
    label: s.label,
    kind: isCombo(s.key) ? "조합" : "지표",
    eventDate: s.lastEventDate,
    daysSince: s.daysSinceLastEvent,
    passCount: s.passCount,
    hitCount: s.hitCount,
    // 데이터가 없어 못 본 옛날 바닥을 분모에 넣으면 알림이 지표를 실제보다 나쁘게 적는다.
    cycles: s.coverage.cyclesCovered,
    partialFrom: s.coverage.full ? null : s.coverage.fromDate,
    lift: s.lift,
    qValue: s.qValue,
    captureSharePct: s.medianCaptureSharePct,
    medianLeadDays: s.medianLeadDays,
    worstDrawdownPct: s.drawdown?.worstPct ?? null,
    dedupeKey: `${s.key}@${s.lastEventDate}`,
  };
}

/**
 * 리포트에서 알릴 신호를 뽑는다. 단일 지표와 조합을 같이 보고,
 * 이미 보낸 것(notified)은 뺀다.
 */
export function findGradeHits(
  report: CycleReport,
  notified: Record<string, string> = {},
): GradeHit[] {
  const cycles = report.cycles.length;
  const all = [...report.signals, ...report.combos];
  const hits: GradeHit[] = [];
  const seen = new Set<string>();

  for (const s of all) {
    const hit = toHit(s, cycles);
    if (!hit) continue;
    if (notified[hit.dedupeKey]) continue;
    if (seen.has(hit.dedupeKey)) continue;
    seen.add(hit.dedupeKey);
    hits.push(hit);
  }

  // 조합이 더 엄한 조건이므로 위로, 그다음은 관문 통과 수 → 늦게 뜬 순.
  return hits.sort(
    (a, b) =>
      Number(b.kind === "조합") - Number(a.kind === "조합") ||
      b.passCount - a.passCount ||
      a.daysSince - b.daysSince,
  );
}

function pct(v: number | null, digits = 0): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;
}

/** 텔레그램 본문. 숫자는 전부 리포트에서 온 값이고, 여기서 새로 계산하지 않는다. */
export function formatGradeAlert(ticker: string, report: CycleReport, hits: GradeHit[]): string {
  const lines: string[] = [
    `🅰 ${ticker} — 근거 있는 신호(A등급) ${hits.length}개가 켜졌습니다`,
    "",
    `${report.periodEnd} 기준 · 지표 ${report.now.on}/${report.now.total}개 켜짐 · 국면 ${report.regime.phase}`,
    "",
  ];

  for (const h of hits) {
    lines.push(`• [${h.kind}] ${h.label}`);
    lines.push(
      `  신호일 ${h.eventDate}${h.daysSince ? ` (${h.daysSince}거래일 전)` : " (오늘)"}` +
        ` · 여섯 관문 ${h.passCount}/6`,
    );
    lines.push(
      `  과거 상승장 시작 ${h.cycles}번 중 ${h.hitCount}번` +
        (h.partialFrom ? ` (${h.partialFrom}부터만 값이 있어 그만큼만 채점)` : "") +
        ` · ` +
        `우연대비 ${h.lift == null ? "—" : `${h.lift.toFixed(1)}배`} · ` +
        `보정확률 ${h.qValue == null ? "—" : pct(h.qValue * 100)}`,
    );
    lines.push(
      `  남은 상승 ${pct(h.captureSharePct)} · ` +
        `리드 ${h.medianLeadDays == null ? "—" : `${h.medianLeadDays > 0 ? "+" : ""}${h.medianLeadDays}일`} · ` +
        `과거 최악 낙폭 ${pct(h.worstDrawdownPct)}`,
    );
  }

  lines.push("");
  lines.push(
    `표본은 이 종목의 과거 상승장 전환 ${report.cycles.length}번뿐입니다. ` +
      "과거 패턴이며 투자 판단의 근거가 아닙니다.",
  );
  return lines.join("\n");
}
