"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import CommandInput from "@/components/CommandInput";
import MatchList from "@/components/MatchList";
import SummaryCard from "@/components/SummaryCard";
import TickerInput from "@/components/TickerInput";
import { runAnalyze } from "@/lib/analyze-client";
import { compactNumber } from "@/lib/format";
import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { loadAnalysis, loadSearchDraft, saveAnalysis, saveSearchDraft, type AnalysisPayload } from "@/lib/session";
import type { FilterSpec } from "@/types";

// lightweight-charts는 브라우저 전용
const VolumeChart = dynamic(() => import("@/components/VolumeChart"), {
  ssr: false,
  loading: () => <div className="h-[276px] rounded-2xl border border-border bg-surface" />,
});

/** 신호 간 최소 간격 선택지 (거래일). 20 ≈ 한 달. */
const MIN_GAP_CHOICES = [0, 5, 10, 20, 40];

export default function ResultsPage() {
  const [payload, setPayload] = useState<AnalysisPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [cluster, setCluster] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tickerInput, setTickerInput] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);

  useEffect(() => {
    const p = loadAnalysis();
    const draft = loadSearchDraft();
    setPayload(p);
    if (p) {
      const matchingDraft = draft?.ticker === p.result.ticker ? draft : null;
      setCluster(p.result.clustered);
      setTickerInput(matchingDraft?.ticker ?? p.result.ticker);
      setCommandInput(matchingDraft?.command ?? p.result.spec.interpretation);
    }
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

  /** 발화 규칙(첫 진입만 · 최소 간격)을 바꿔 같은 조건으로 다시 계산한다. */
  const updateTrigger = useCallback(
    async (patch: Partial<Pick<FilterSpec, "fresh_only" | "min_gap_days">>) => {
      if (!result) return;
      setBusy(true);
      try {
        const nextSpec: FilterSpec = { ...result.spec, ...patch };
        const data = await runAnalyze(result.ticker, nextSpec, { cluster });
        saveAnalysis(data);
        setPayload(data);
      } catch {
        // 실패하면 기존 결과를 그대로 둔다.
      } finally {
        setBusy(false);
      }
    },
    [cluster, result],
  );

  const reanalyze = useCallback(async () => {
    setEditorError(null);
    const ticker = normalizeTicker(tickerInput);
    if (!ticker) return setEditorError("티커를 입력해 주세요.");
    if (!isValidTicker(ticker)) return setEditorError("올바른 티커 형식이 아닙니다.");
    if (!commandInput.trim()) return setEditorError("무엇을 찾을지 입력해 주세요.");

    const command = commandInput.trim();
    saveSearchDraft({ ticker, command });
    setBusy(true);
    try {
      const parseRes = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const parsed = (await parseRes.json()) as { spec?: FilterSpec; error?: string };
      if (!parseRes.ok || !parsed.spec) {
        throw new Error(parsed.error ?? "명령을 이해하지 못했어요.");
      }

      const data = await runAnalyze(ticker, parsed.spec);
      saveAnalysis(data);
      setPayload(data);
      setCluster(data.result.clustered);
      setTickerInput(ticker);
      setCommandInput(command);
      setConfirmed(false);
      setEditing(false);
    } catch (e) {
      setEditorError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [commandInput, tickerInput]);

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
          ← 첫 화면
        </Link>
        <button
          type="button"
          onClick={exportCsv}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-muted"
        >
          CSV 내보내기
        </button>
      </div>

      <section className="mb-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted">현재 분석</p>
            <p className="truncate text-base font-bold">{result.ticker}</p>
          </div>
          <button
            type="button"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
            className="shrink-0 rounded-lg border border-border bg-bg px-3 py-2 text-sm font-medium"
          >
            {editing ? "닫기" : "티커·명령 수정"}
          </button>
        </div>

        {editing ? (
          <div className="mt-4 space-y-4 border-t border-border pt-4">
            <TickerInput
              value={tickerInput}
              onChange={(next) => {
                setTickerInput(next);
                saveSearchDraft({ ticker: next, command: commandInput });
              }}
            />
            <CommandInput
              value={commandInput}
              onChange={(next) => {
                setCommandInput(next);
                saveSearchDraft({ ticker: tickerInput, command: next });
              }}
            />
            {editorError ? (
              <p className="rounded-xl border border-down/40 bg-down/10 px-4 py-3 text-sm text-down">
                {editorError}
              </p>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={reanalyze}
              className="w-full rounded-xl bg-blue-500 py-3 text-sm font-bold text-white disabled:opacity-50"
            >
              {busy ? "분석 중…" : "이 조건으로 다시 분석"}
            </button>
          </div>
        ) : null}
      </section>

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

      <section className="mb-3 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-semibold">신호 발화 규칙</p>
          <p className="text-xs text-muted">
            조건 충족 {result.rawMatchCount}일 → 신호 {result.stats.matchCount}개
          </p>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">첫 진입만</p>
            <p className="text-xs leading-relaxed text-muted">
              조건에 새로 들어온 날만 신호로 셉니다 (20일 롤링 지표는 며칠씩 계속 참이라 그대로 두면 신호가 몰립니다)
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => updateTrigger({ fresh_only: !result.trigger.freshOnly })}
            className={`h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50 ${
              result.trigger.freshOnly ? "bg-blue-500" : "bg-border"
            }`}
            aria-pressed={result.trigger.freshOnly}
            aria-label="첫 진입만"
          >
            <span
              className={`block h-6 w-6 rounded-full bg-white transition-transform ${
                result.trigger.freshOnly ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        <div className="mt-3 border-t border-border pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium">신호 간 최소 간격</p>
            <p className="text-xs text-muted">
              {result.trigger.minGapDays === 0
                ? "제한 없음"
                : `${result.trigger.minGapDays}거래일`}
            </p>
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            {MIN_GAP_CHOICES.map((days) => {
              const active = result.trigger.minGapDays === days;
              return (
                <button
                  key={days}
                  type="button"
                  disabled={busy}
                  onClick={() => updateTrigger({ min_gap_days: days })}
                  aria-pressed={active}
                  className={`rounded-lg border py-2 text-xs font-medium tabular-nums transition disabled:opacity-50 ${
                    active ? "border-blue-400 bg-blue-500/15" : "border-border bg-bg text-muted"
                  }`}
                >
                  {days === 0 ? "없음" : `${days}일`}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">연속일 묶기</p>
            <p className="text-xs text-muted">연속으로 붙은 매칭일을 하나로 계산</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => toggleCluster(!cluster)}
            className={`h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50 ${
              cluster ? "bg-blue-500" : "bg-border"
            }`}
            aria-pressed={cluster}
            aria-label="연속일 묶기"
          >
            <span
              className={`block h-6 w-6 rounded-full bg-white transition-transform ${
                cluster ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </section>

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
