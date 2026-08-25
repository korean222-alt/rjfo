"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import MatchList from "@/components/MatchList";
import SummaryCard from "@/components/SummaryCard";
import { runAnalyze } from "@/lib/analyze-client";
import { compactNumber } from "@/lib/format";
import { loadAnalysis, saveAnalysis, type AnalysisPayload } from "@/lib/session";

// lightweight-charts는 브라우저 전용
const VolumeChart = dynamic(() => import("@/components/VolumeChart"), {
  ssr: false,
  loading: () => <div className="h-[276px] rounded-2xl border border-border bg-surface" />,
});

export default function ResultsPage() {
  const [payload, setPayload] = useState<AnalysisPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [cluster, setCluster] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    const p = loadAnalysis();
    setPayload(p);
    if (p) setCluster(p.result.clustered);
    setLoaded(true);
  }, []);

  const result = payload?.result ?? null;

  const matchDates = useMemo(
    () => (result ? result.matches.map((m) => m.date) : []),
    [result],
  );

  // 클러스터 토글은 서버에서 다시 계산한다 (계산은 전부 서버 코드가 한다)
  const toggleCluster = useCallback(
    async (next: boolean) => {
      if (!result) return;
      setBusy(true);
      try {
        const data = await runAnalyze(result.ticker, result.spec, { cluster: next });
        saveAnalysis(data);
        setPayload(data);
        setCluster(next);
      } catch {
        // 토글 실패는 화면을 그대로 두면 된다 (기존 결과가 유효하다).
      } finally {
        setBusy(false);
      }
    },
    [result],
  );

  const exportCsv = useCallback(() => {
    if (!result) return;
    const header = [
      "date", "close", "volume", "volume_ratio_20d", "close_change_pct",
      "close_position_in_range", "return_5d", "return_20d", "return_60d", "max_return_20d",
    ];
    const rows = result.matches.map((m) => [
      m.date,
      m.close.toFixed(4),
      m.volume,
      m.volumeRatio?.toFixed(4) ?? "",
      m.closeChangePct?.toFixed(4) ?? "",
      m.closePosition.toFixed(4),
      m.forwardReturns.d5?.toFixed(4) ?? "",
      m.forwardReturns.d20?.toFixed(4) ?? "",
      m.forwardReturns.d60?.toFixed(4) ?? "",
      m.maxForwardReturn20d?.toFixed(4) ?? "",
    ]);
    const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
    // 엑셀에서 한글/숫자 깨짐 방지용 BOM
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.ticker}_matches.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  if (!loaded) {
    return <main className="mx-auto max-w-lg px-4 py-8 text-muted">불러오는 중…</main>;
  }

  if (!result || !payload) {
    return (
      <main className="mx-auto max-w-lg px-4 py-8">
        <p className="text-muted">분석 결과가 없습니다.</p>
        <Link href="/" className="mt-4 inline-block text-blue-400 underline">
          처음으로 돌아가기
        </Link>
      </main>
    );
  }

  const needsConfirm = result.spec.confidence === "low" && !confirmed;

  return (
    <main className="mx-auto max-w-lg px-4 py-6 pb-28">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/" className="text-sm text-muted">
          ← 다시 분석
        </Link>
        <button
          type="button"
          onClick={exportCsv}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-muted"
        >
          CSV 내보내기
        </button>
      </div>

      {/* lookahead는 미래 데이터를 보는 것이므로 반드시 명시한다 */}
      {result.lookaheadUsed ? (
        <p className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-300">
          ⚠ 백테스트 전용 — 실시간 매매 신호 아님
          <span className="mt-1 block font-normal text-amber-200/80">
            이 조건은 “이후에 실제로 올랐던 날”만 골라낸 것이라, 그 시점에는 알 수 없는 정보입니다.
          </span>
        </p>
      ) : null}

      {/* 해석 문구 + 애매한 경우 확인 UI */}
      <section className="mb-3 rounded-2xl border border-border bg-surface p-4">
        <p className="text-xs text-muted">이렇게 해석했습니다</p>
        <p className="mt-1 leading-relaxed">{result.spec.interpretation}</p>
        {needsConfirm ? (
          <div className="mt-3">
            <p className="text-sm text-amber-300">이렇게 해석했는데 맞나요?</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmed(true)}
                className="flex-1 whitespace-nowrap rounded-lg border border-border bg-bg px-3 py-2 text-sm"
              >
                맞아요
              </button>
              <Link
                href="/"
                className="flex-1 whitespace-nowrap rounded-lg border border-border bg-bg px-3 py-2 text-center text-sm"
              >
                다시 쓸게요
              </Link>
            </div>
          </div>
        ) : null}
      </section>

      {result.warnings.map((w) => (
        <p
          key={w}
          className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-200"
        >
          {w}
        </p>
      ))}

      <SummaryCard result={result} />

      <div className="my-4">
        <VolumeChart series={payload.series} matchDates={matchDates} />
      </div>

      <div className="mb-3 flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3">
        <div>
          <p className="text-sm font-medium">연속일 묶기</p>
          <p className="text-xs text-muted">연속으로 붙은 매칭일을 하나로 계산</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => toggleCluster(!cluster)}
          className={`h-7 w-12 rounded-full transition disabled:opacity-50 ${
            cluster ? "bg-blue-500" : "bg-border"
          }`}
          aria-pressed={cluster}
        >
          <span
            className={`block h-6 w-6 rounded-full bg-white transition-transform ${
              cluster ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted">
        매칭 날짜 · 총 거래량 {compactNumber(result.matches.reduce((a, m) => a + m.volume, 0))}
      </h2>
      <MatchList matches={result.matches} />

      <p className="fixed inset-x-0 bottom-0 border-t border-border bg-bg/95 py-3 text-center text-xs text-muted backdrop-blur">
        과거 패턴이며 투자 판단의 근거가 아닙니다.
      </p>
    </main>
  );
}
