"use client";

import { useMemo, useState } from "react";
import { HORIZON_LABELS, HORIZONS, SIGNAL_GROUPS } from "@/lib/cycle";
import type { CycleReport, SignalEvaluation } from "@/lib/cycle";

type SortKey = "score" | "hitRate" | "lead" | "edge" | "lift" | "chance";

const SORTS: { key: SortKey; label: string; hint: string }[] = [
  { key: "score", label: "종합", hint: "적중률·정확도·남은 상승을 섞은 순위" },
  { key: "chance", label: "우연 아닌 순", hint: "아무 데나 같은 횟수만큼 찍어도 이만큼 맞을 확률이 낮은 순" },
  { key: "hitRate", label: "적중률", hint: "과거 상승장 시작을 몇 번 잡았나" },
  { key: "lead", label: "빠른 순", hint: "바닥 대비 얼마나 일찍 떴나" },
  { key: "edge", label: "기저율 대비", hint: "아무 날이나 샀을 때보다 얼마나 나았나" },
  { key: "lift", label: "우연대비", hint: "아무 날이나 찍었을 때보다 몇 배 자주 상승장 시작을 가리켰나" },
];

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
 * 우연일 확률을 사람이 읽는 말로.
 * 숫자만 주면 0.03과 0.30의 차이를 눈으로 못 읽는다 — 색과 문구를 같이 준다.
 */
function chanceText(p: number | null | undefined): { text: string; tone: string } {
  return { text: `우연일 확률 ${chancePct(p)}`, tone: chanceTone(p) };
}

function num(n: number | null | undefined, digits = 0, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

function signed(n: number | null | undefined, digits = 0, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}${suffix}`;
}

function toneFor(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "text-muted";
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-muted";
}

function leadText(days: number | null): string {
  if (days == null) return "—";
  if (days === 0) return "바닥 당일";
  return days > 0 ? `${days}일 늦게` : `${Math.abs(days)}일 먼저`;
}

type Props = {
  report: CycleReport;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
};

export default function CycleSignalTable({ report, selectedKey, onSelect }: Props) {
  const [sort, setSort] = useState<SortKey>("score");
  const [group, setGroup] = useState<string>("전체");
  const [onlyOn, setOnlyOn] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(() => {
    const filtered = report.signals.filter(
      (s) => (group === "전체" || s.group === group) && (!onlyOn || s.currentlyOn),
    );
    const value = (s: SignalEvaluation): number => {
      switch (sort) {
        case "hitRate":
          return s.hitRate ?? -1;
        case "lead":
          // 작을수록(먼저 뜰수록) 위. 못 잡은 지표는 맨 뒤로.
          return s.medianLeadDays == null ? Number.POSITIVE_INFINITY : s.medianLeadDays;
        case "edge":
          return s.edge ?? Number.NEGATIVE_INFINITY;
        case "lift":
          return s.lift ?? -1;
        case "chance":
          // 낮을수록 위. 신호가 없어 못 재는 지표는 맨 뒤로.
          return s.chance ?? Number.POSITIVE_INFINITY;
        default:
          return s.score;
      }
    };
    const asc = sort === "lead" || sort === "chance";
    return [...filtered].sort((a, b) => (asc ? value(a) - value(b) : value(b) - value(a)));
  }, [report.signals, sort, group, onlyOn]);

  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">지표 성적표</h2>
        <span className="text-xs text-muted">{rows.length}개</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            title={s.hint}
            onClick={() => setSort(s.key)}
            className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${
              sort === s.key
                ? "border-blue-500 bg-blue-500/15 text-white"
                : "border-border bg-bg text-muted"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {["전체", ...SIGNAL_GROUPS].map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGroup(g)}
            className={`rounded-lg border px-2 py-1 text-[11px] ${
              group === g ? "border-muted text-white" : "border-border bg-bg text-muted"
            }`}
          >
            {g}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOnlyOn((v) => !v)}
          className={`ml-auto rounded-lg border px-2 py-1 text-[11px] ${
            onlyOn ? "border-up/60 bg-up/10 text-up" : "border-border bg-bg text-muted"
          }`}
        >
          지금 켜진 것만
        </button>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        적중률 = 과거 상승장 시작 {report.cycles.length}번 중 그 부근에서 <b className="text-white">새로 켜져서</b>{" "}
        잡은 횟수(하락장 내내 켜진 채 바닥을 지나온 건 적중이 아니라 &lsquo;이미 켜짐&rsquo;) · 리드 = 실제 바닥 대비
        신호 시점 · 남은상승 = 신호 시점에 그 사이클 상승분이 얼마나 남아 있었나 ·{" "}
        <b className="text-white">우연대비</b> = 아무 날이나 찍었을 때 대비 배수(1.0이면 우연과 같음, 전체 기간의{" "}
        {num(report.windowSharePct, 0, "%")}가 상승장 시작 부근) · 기저대비 = 신호 후 1년 수익률 − 아무 날이나
        골랐을 때(연 {num(report.baseline["250"].avg, 0, "%")}) ·{" "}
        <b className="text-white">우연일 확률</b> = 이 지표의 신호를 통째로 아무 시점으로나 옮겨도 이만큼 맞을 확률
        (낮을수록 좋고, <span className="text-up">20% 미만이면 초록불</span>, 5% 미만이면 우연으로 보기 어렵습니다)
      </p>

      <ul className="mt-3 space-y-1.5">
        {rows.map((s) => {
          const open = expanded === s.key;
          const isSelected = selectedKey === s.key;
          return (
            <li key={s.key} className="rounded-xl border border-border bg-bg">
              <button
                type="button"
                onClick={() => setExpanded(open ? null : s.key)}
                aria-expanded={open}
                className="w-full px-3 py-2.5 text-left"
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full ${s.currentlyOn ? "bg-up" : "bg-border"}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.label}</span>
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">
                    {s.timeframe}
                  </span>
                  <span className="shrink-0 text-sm font-bold">
                    {s.hitCount}/{report.cycles.length}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-4 text-[11px] text-muted">
                  <span>리드 {leadText(s.medianLeadDays)}</span>
                  {s.alreadyOnCount ? <span>이미 켜짐 {s.alreadyOnCount}회</span> : null}
                  <span>남은상승 {num(s.medianCaptureSharePct, 0, "%")}</span>
                  <span
                    className={
                      s.lift == null ? "text-muted" : s.lift >= 1.5 ? "text-up" : s.lift < 1 ? "text-down" : ""
                    }
                  >
                    우연대비 {num(s.lift, 1, "배")}
                  </span>
                  <span className={toneFor(s.edge)}>기저대비 {signed(s.edge, 0, "%p")}</span>
                  <span className={chanceText(s.chance).tone}>{chanceText(s.chance).text}</span>
                </div>
              </button>

              {open ? (
                <div className="space-y-3 border-t border-border px-3 py-3">
                  <p className="text-xs leading-relaxed text-muted">{s.why}</p>

                  <div>
                    <p className="mb-1 text-[11px] font-semibold text-muted">사이클별 적중</p>
                    <ul className="space-y-1">
                      {s.cycleHits.map((h) => (
                        <li key={h.troughDate} className="flex flex-wrap gap-x-2 text-[11px]">
                          <span className="text-muted">{h.troughDate} 바닥 →</span>
                          {h.hit ? (
                            <>
                              <span className="text-up">{h.eventDate}</span>
                              <span className="text-muted">
                                ({leadText(h.leadDays)}, 남은 상승 {num(h.captureSharePct, 0, "%")})
                              </span>
                            </>
                          ) : h.alreadyOn ? (
                            <span className="text-muted">
                              적중 아님 — 창 안에 새 신호가 없고, 바닥 당시 이미 켜져 있던 상태
                              {h.eventDate ? ` (${h.eventDate}에 켜짐)` : ""}
                            </span>
                          ) : (
                            <span className="text-down">신호 없음</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
                    <p className="text-[11px] font-semibold">이게 우연일까?</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">
                      이 지표는 전체 기간에 <b className="text-white">{s.eventCount}번</b> 떴고, 그중{" "}
                      <b className="text-white">{s.inWindowEvents.length}번</b>이 상승장 시작 부근이었습니다
                      (정확도 {num(s.precision, 0, "%")} · 나머지 {s.falseAlarms}번은 헛신호). 상승장 시작 부근은
                      전체 기간의 {num(report.windowSharePct, 0, "%")}뿐이니, 이 신호들을 간격째로 아무 시점으로나
                      옮겨도 이만큼 맞을 확률은{" "}
                      <b className={chanceTone(s.chance)}>{chancePct(s.chance)}</b>입니다.
                      {s.chance != null && s.chance >= 0.2
                        ? " 우연으로도 충분히 나오는 성적입니다."
                        : s.chance != null && s.chance >= 0.05
                          ? " 우연이라기엔 낮지만 확실하다고 하기엔 애매한 구간입니다."
                          : s.chance != null
                            ? " 사이클 표본 자체가 적다는 점은 감안하세요."
                            : ""}
                    </p>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                      과거 상승장 시작 {report.cycles.length}번 중{" "}
                      <b className="text-white">{s.hitCount}번</b>을 새로 켜지면서 잡았습니다 (적중률{" "}
                      {num(s.hitRate, 0, "%")}).
                      {s.alreadyOnCount
                        ? ` 그 밖에 ${s.alreadyOnCount}번은 창 안에 새 신호가 없었고 바닥 당시 이미 켜져 있기만 했습니다 — 적중으로 세지 않았습니다.`
                        : ""}
                    </p>
                  </div>

                  <div>
                    <p className="mb-1 text-[11px] font-semibold text-muted">
                      신호 후 수익률 (신호 {s.eventCount}회 · 상승장 시작 부근 아니었던 신호 {s.falseAlarms}회 ·
                      정확도 {num(s.precision, 0, "%")})
                    </p>
                    <table className="w-full text-[11px]">
                      <thead className="text-muted">
                        <tr>
                          <th className="text-left font-normal">기간</th>
                          <th className="text-right font-normal">평균</th>
                          <th className="text-right font-normal">중앙값</th>
                          <th className="text-right font-normal">플러스 비율</th>
                          <th className="text-right font-normal">기저율</th>
                        </tr>
                      </thead>
                      <tbody>
                        {HORIZONS.map((h) => {
                          const f = s.forward[String(h)];
                          const b = report.baseline[String(h)];
                          return (
                            <tr key={h}>
                              <td className="py-0.5">{HORIZON_LABELS[h]}</td>
                              <td className={`py-0.5 text-right ${toneFor(f.avg)}`}>
                                {signed(f.avg, 1, "%")}
                              </td>
                              <td className="py-0.5 text-right">{signed(f.median, 1, "%")}</td>
                              <td className="py-0.5 text-right">{num(f.winRate, 0, "%")}</td>
                              <td className="py-0.5 text-right text-muted">{signed(b.avg, 1, "%")}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {s.lift != null && s.lift < 1 ? (
                    <p className="rounded-lg border border-down/30 bg-down/5 px-2.5 py-2 text-[11px] leading-relaxed text-down">
                      이 지표는 아무 날이나 찍는 것보다 상승장 시작을 <b>덜</b> 가리켰습니다(우연대비{" "}
                      {s.lift.toFixed(2)}배). 적중률이 높은 건 자주 켜지기 때문일 뿐입니다.
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSelect(isSelected ? null : s.key)}
                      className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${
                        isSelected
                          ? "border-amber-400/60 bg-amber-400/10 text-amber-300"
                          : "border-border bg-surface text-muted"
                      }`}
                    >
                      {isSelected ? "차트에서 내리기" : "📈 차트에서 보기"}
                    </button>
                    <span className="text-[11px] text-muted">
                      마지막 신호 {s.lastEventDate ?? "—"}
                      {s.daysSinceLastEvent != null ? ` (${s.daysSinceLastEvent}일 전)` : ""}
                    </span>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
