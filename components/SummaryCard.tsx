"use client";

import type { AnalysisResult } from "@/types";
import { pct, pctPoint } from "@/lib/format";

const NEUTRAL_BAND = 3; // ±3%p 이내는 "유의미한 차이 없음"

function edgeTone(diff: number | null): { color: string; label: string } {
  if (diff == null) return { color: "text-muted", label: "비교 불가" };
  if (Math.abs(diff) <= NEUTRAL_BAND) return { color: "text-flat", label: "유의미한 차이 없음" };
  return diff > 0
    ? { color: "text-up", label: "조건이 base rate보다 우세" }
    : { color: "text-down", label: "조건이 base rate보다 열세" };
}

export default function SummaryCard({ result }: { result: AnalysisResult }) {
  const tone = edgeTone(result.edge.hitRateDiff);

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold">{result.ticker}</h2>
        <span className="text-xs text-muted">
          {result.periodStart} ~ {result.periodEnd} · {result.totalBars}거래일
        </span>
      </div>

      {/* 이 앱의 존재 이유: 조건 성과 vs 아무 날이나 골랐을 때의 성과 */}
      <div className="mt-5 text-center">
        <p className="text-sm text-muted">승률 차이 (조건 − 전체 평균)</p>
        <p className={`mt-1 text-5xl font-black tabular-nums ${tone.color}`}>
          {pctPoint(result.edge.hitRateDiff)}
        </p>
        <p className={`mt-1 text-sm ${tone.color}`}>{tone.label}</p>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-xl bg-bg p-3">
          <p className="text-xs text-muted">매칭</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{result.stats.matchCount}일</p>
        </div>
        <div className="rounded-xl bg-bg p-3">
          <p className="text-xs text-muted">조건 승률</p>
          <p className="mt-1 text-xl font-bold tabular-nums">
            {result.stats.hitRate == null ? "—" : `${result.stats.hitRate.toFixed(0)}%`}
          </p>
        </div>
        <div className="rounded-xl bg-bg p-3">
          <p className="text-xs text-muted">전체 평균</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-muted">
            {result.baseline.hitRate == null ? "—" : `${result.baseline.hitRate.toFixed(0)}%`}
          </p>
        </div>
      </div>

      <p className="mt-2 text-center text-[11px] text-muted">
        승률 = 20거래일 안에 고점 기준 +10% 이상 간 비율
      </p>

      <div className="mt-4 space-y-2 text-sm">
        <Row
          label="평균 20일 수익률"
          a={pct(result.stats.avgReturn20d)}
          b={pct(result.baseline.avgReturn20d)}
          diff={pctPoint(result.edge.avgReturnDiff)}
        />
        <Row
          label="중앙값 20일 수익률"
          a={pct(result.stats.medianReturn20d)}
          b={pct(result.baseline.medianReturn20d)}
        />
      </div>
    </section>
  );
}

function Row({ label, a, b, diff }: { label: string; a: string; b: string; diff?: string }) {
  return (
    <div className="flex items-center justify-between border-t border-border pt-2">
      <span className="text-muted">{label}</span>
      <span className="tabular-nums">
        <strong>{a}</strong>
        <span className="text-muted"> vs {b}</span>
        {diff ? <span className="text-muted"> ({diff})</span> : null}
      </span>
    </div>
  );
}
