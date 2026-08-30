"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BtcSpotHeader from "@/components/BtcSpotHeader";
import CycleSignalTable from "@/components/CycleSignalTable";
import NavTabs from "@/components/NavTabs";
import TickerInput from "@/components/TickerInput";
import TimeframeSelect from "@/components/TimeframeSelect";
import { SIGNAL_GROUPS, completedStarts, snapshotOnPct } from "@/lib/cycle";
import { enrichForPlot, plotForView } from "@/lib/cycle/plot";
import {
  barsForView,
  CHART_TF_LABEL,
  CHART_TF_TV,
  snapDatesToView,
  type ChartTf,
} from "@/lib/cycle/resample";
import { runCycle, type CyclePayload } from "@/lib/cycle-client";
import { isCryptoTicker, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { clearCycle, loadCycle, saveCycle } from "@/lib/session";
import { toTradingViewSymbol } from "@/lib/tradingview";

const CycleChart = dynamic(() => import("@/components/CycleChart"), {
  ssr: false,
  loading: () => <div className="h-[320px] rounded-2xl border border-border bg-surface" />,
});

const TradingViewChart = dynamic(() => import("@/components/TradingViewChart"), {
  ssr: false,
  loading: () => <div className="h-[360px] rounded-2xl border border-border bg-surface" />,
});

const EXAMPLES = ["BTC", "ETH", "IONQ", "NVDA", "005930"];

function signed(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export default function CyclePage() {
  const [ticker, setTicker] = useState("");
  const [payload, setPayload] = useState<CyclePayload | null>(null);
  const [busy, setBusy] = useState<null | "analyze" | "fallback" | "ask">(null);
  const [error, setError] = useState<string | null>(null);
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tuning, setTuning] = useState(false);
  const [bearPct, setBearPct] = useState<number | null>(null);
  const [bullPct, setBullPct] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const [tf, setTf] = useState<ChartTf>("1d");
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = loadCycle<CyclePayload>();
    if (!saved?.report) return;
    setPayload(saved);
    setTicker(saved.report.ticker);
    setBearPct(saved.report.thresholds.bearPct);
    setBullPct(saved.report.thresholds.bullPct);
  }, []);

  // URL로 티커를 받으면(AI 비서가 보낸 링크) 바로 돌린다.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("ticker");
    if (t) {
      setTicker(t);
      void run(t);
    }
    // 최초 1회만.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    async (rawTicker?: string, extra?: { bearPct?: number; bullPct?: number; question?: string }) => {
      setError(null);
      setTickerError(null);
      const t = normalizeTicker(rawTicker ?? ticker);
      if (!t) return setTickerError("티커를 입력해 주세요.");
      if (!isValidTicker(t)) return setTickerError("올바른 티커 형식이 아닙니다.");

      setBusy(extra?.question ? "ask" : "analyze");
      try {
        const next = await runCycle(
          {
            ticker: t,
            bearPct: extra?.bearPct ?? bearPct ?? undefined,
            bullPct: extra?.bullPct ?? bullPct ?? undefined,
            question: extra?.question,
          },
          () => setBusy("fallback"),
        );
        setPayload(next);
        setTicker(next.report.ticker);
        setBearPct(next.report.thresholds.bearPct);
        setBullPct(next.report.thresholds.bullPct);
        setSelectedKey(null);
        saveCycle(next);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [bearPct, bullPct, ticker],
  );

  const report = payload?.report ?? null;

  const selectedSignal = useMemo(
    () => (report && selectedKey ? report.signals.find((s) => s.key === selectedKey) ?? null : null),
    [report, selectedKey],
  );

  // 지표 선을 그리려면 파생값(OBV 기울기 등)이 필요하다. 서버 채점과 같은 함수를 쓴다.
  // 5,000봉짜리 계산이라 티커가 바뀔 때만 한 번 돈다.
  const enrichedBars = useMemo(
    () => (payload?.series?.length ? enrichForPlot(payload.series) : null),
    [payload?.series],
  );

  const plot = useMemo(
    () => (enrichedBars && selectedKey ? plotForView(selectedKey, enrichedBars, tf) : null),
    [enrichedBars, selectedKey, tf],
  );

  const viewSeries = useMemo(
    () => (payload?.series?.length ? barsForView(payload.series, tf) : []),
    [payload?.series, tf],
  );

  /** 성적표 순위(= 종합 순) 그대로 앞뒤로 넘긴다. */
  const stepSignal = useCallback(
    (delta: number) => {
      if (!report?.signals.length) return;
      const list = report.signals;
      const at = selectedKey ? list.findIndex((s) => s.key === selectedKey) : -1;
      const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
      setSelectedKey(list[next].key);
    },
    [report, selectedKey],
  );

  /**
   * 차트에 찍을 신호일.
   *
   * RSI 50처럼 자주 켜지는 지표는 20년에 250번씩 뜬다. 전부 찍으면 점이 캔들을
   * 덮어버려 아무것도 안 보인다. 그때는 '상승장 시작 부근에서 뜬 것'만 남긴다
   * (숨겼다는 사실은 차트 아래에 적는다).
   */
  const MAX_MARKERS = 60;
  const matchedDates = useMemo(
    () =>
      selectedSignal
        ? selectedSignal.cycleHits.map((h) => h.eventDate).filter((d): d is string => d != null)
        : [],
    [selectedSignal],
  );
  const markerDates = useMemo(() => {
    if (!selectedSignal) return [];
    return selectedSignal.events.length <= MAX_MARKERS ? selectedSignal.events : matchedDates;
  }, [selectedSignal, matchedDates]);
  const markersTrimmed = Boolean(selectedSignal && selectedSignal.events.length > MAX_MARKERS);

  const dailyBars = payload?.series ?? [];
  const troughDates = useMemo(
    () =>
      report
        ? snapDatesToView(
            report.cycles.map((c) => c.troughDate),
            dailyBars,
            tf,
          )
        : [],
    [report, dailyBars, tf],
  );
  const peakDates = useMemo(
    () =>
      report
        ? snapDatesToView(
            report.cycles.map((c) => c.nextPeakDate).filter((d): d is string => d != null),
            dailyBars,
            tf,
          )
        : [],
    [report, dailyBars, tf],
  );
  const snappedMarkers = useMemo(
    () => snapDatesToView(markerDates, dailyBars, tf),
    [markerDates, dailyBars, tf],
  );
  const snappedMatched = useMemo(
    () => snapDatesToView(matchedDates, dailyBars, tf),
    [matchedDates, dailyBars, tf],
  );

  const crypto = Boolean(report && isCryptoTicker(report.ticker));

  const showSignal = useCallback((key: string | null) => {
    setSelectedKey(key);
    if (key) chartRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const completeStarts = useMemo(
    () => (report ? completedStarts(report.cycleStarts, report.now.date) : []),
    [report],
  );
  const avgAtStart = useMemo(() => {
    if (!completeStarts.length) return null;
    return completeStarts.reduce((a, c) => a + snapshotOnPct(c), 0) / completeStarts.length;
  }, [completeStarts]);

  const commonSignals = useMemo(
    () => (report ? report.signals.filter((s) => report.commonKeys.includes(s.key)) : []),
    [report],
  );

  return (
    <main className="mx-auto max-w-lg px-4 py-6 pb-28">
      <NavTabs />

      <header className="mb-6">
        <h1 className="text-2xl font-black">상승장 지표</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          티커를 넣으면 그 종목의 과거 상승장 시작점을 찾아내고, 그때마다 어떤 지표들이 공통으로
          신호를 줬는지 전부 채점합니다.
        </p>
      </header>

      <div className="space-y-4">
        <TickerInput value={ticker} onChange={setTicker} error={tickerError} />

        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setTicker(ex);
                void run(ex);
              }}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[11px] text-muted disabled:opacity-50"
            >
              {ex}
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-border bg-surface">
          <button
            type="button"
            onClick={() => setTuning((v) => !v)}
            aria-expanded={tuning}
            className="flex w-full items-center justify-between px-4 py-3 text-left"
          >
            <span className="text-sm font-medium">상승장 판정 기준</span>
            <span className="text-xs text-muted">
              {bearPct != null && bullPct != null ? `-${bearPct}% / +${bullPct}%` : "자동"} {tuning ? "▲" : "▼"}
            </span>
          </button>
          {tuning ? (
            <div className="space-y-3 border-t border-border px-4 py-3">
              <p className="text-[11px] leading-relaxed text-muted">
                고점 대비 <b>하락 기준</b>만큼 빠진 뒤, 저점 대비 <b>반등 기준</b>만큼 오른 그 저점을
                상승장 시작으로 봅니다. 코인은 기본 -40%/+50%, 주식은 -20%/+25%입니다. 기준을 낮추면
                사이클 수가 늘지만 잔파동까지 상승장으로 세게 됩니다.
              </p>
              <label className="block text-xs text-muted">
                하락 기준 {bearPct ?? "자동"}%
                <input
                  type="range"
                  min={10}
                  max={70}
                  step={5}
                  value={bearPct ?? 30}
                  onChange={(e) => setBearPct(Number(e.target.value))}
                  className="mt-1 w-full"
                />
              </label>
              <label className="block text-xs text-muted">
                반등 기준 {bullPct ?? "자동"}%
                <input
                  type="range"
                  min={10}
                  max={80}
                  step={5}
                  value={bullPct ?? 30}
                  onChange={(e) => setBullPct(Number(e.target.value))}
                  className="mt-1 w-full"
                />
              </label>
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-xl border border-down/40 bg-down/10 px-4 py-3 text-sm text-down">{error}</p>
        ) : null}

        <button
          type="button"
          onClick={() => void run()}
          disabled={busy !== null}
          className="w-full rounded-xl bg-blue-500 py-4 text-base font-bold text-white transition active:scale-[0.99] disabled:opacity-50"
        >
          {busy === "analyze"
            ? "과거 사이클 분석 중…"
            : busy === "fallback"
              ? "시세 직접 받아오는 중…"
              : busy === "ask"
                ? "다시 묻는 중…"
                : "상승장 지표 찾기"}
        </button>
      </div>

      {report && payload ? (
        <div className="mt-6 space-y-4">
          {/* AI 요약 */}
          <section className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4">
            <h2 className="text-sm font-semibold">AI 요약</h2>
            <p className="mt-2 text-sm leading-relaxed">{payload.reply}</p>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!question.trim()) return;
                void run(report.ticker, { question: question.trim() });
                setQuestion("");
              }}
            >
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="예: 지금 사도 되는 자리야?"
                className="min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-muted"
              />
              <button
                type="submit"
                disabled={busy !== null || !question.trim()}
                className="shrink-0 rounded-xl bg-blue-500 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                물어보기
              </button>
            </form>
          </section>

          {/* 현재 상태 */}
          <section className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">지금 상태</h2>
              <span className="text-xs text-muted">{report.now.date} 기준</span>
            </div>
            <p className="mt-2 text-2xl font-black">
              {report.now.on}
              <span className="text-base font-medium text-muted">
                {" "}
                / {report.now.total}개 켜짐
                {report.now.total
                  ? ` (${Math.round((report.now.on / report.now.total) * 100)}%)`
                  : ""}
              </span>
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg">
              <div
                className="h-full bg-up transition-all"
                style={{ width: `${report.now.total ? (report.now.on / report.now.total) * 100 : 0}%` }}
              />
            </div>
            <p className="mt-2.5 text-xs leading-relaxed text-muted">
              현재 국면은 <b className="text-white">{report.regime.phase}</b>
              {report.regime.since ? ` (${report.regime.since}부터, ${signed(report.regime.fromPivotPct, 1)})` : ""}.
              {avgAtStart != null
                ? ` 과거 상승장 시작 30거래일 뒤에는 평균 ${Math.round(avgAtStart)}%가 켜져 있었습니다 (${completeStarts.length}번 기준).`
                : ""}
            </p>
            {report.cycleStarts.length ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {report.cycleStarts.map((c, i) => {
                  const done =
                    typeof c.complete === "boolean"
                      ? c.complete
                      : !(i === report.cycleStarts.length - 1 && c.measuredDate === report.now.date);
                  const pct = snapshotOnPct(c);
                  return (
                  <li
                    key={c.troughDate}
                    className={`rounded border border-border bg-bg px-2 py-1 text-[11px] text-muted${
                      done ? "" : " opacity-50"
                    }`}
                  >
                    {c.troughDate} → {c.on}/{c.total} ({Math.round(pct)}%)
                    {done ? "" : " (진행중)"}
                  </li>
                  );
                })}
              </ul>
            ) : null}
          </section>

          {/* 사이클 목록 + 차트 */}
          <section className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">찾아낸 상승장 시작</h2>
              <span className="text-xs text-muted">
                {report.periodStart}~{report.periodEnd} ({report.years.toFixed(1)}년)
              </span>
            </div>
            {report.cycles.length ? (
              <ul className="mt-3 space-y-1.5">
                {report.cycles.map((c) => (
                  <li key={c.troughDate} className="rounded-xl border border-border bg-bg px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-bold text-up">{c.troughDate}</span>
                      <span className="text-xs text-muted">
                        {c.closed ? `${c.nextPeakDate} 고점` : "진행 중"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted">
                      직전 고점 {c.peakDate ?? "데이터 시작 전"}에서{" "}
                      <b className="text-down">{signed(c.drawdownPct, 0)}</b> 하락 후{" "}
                      <b className="text-up">{signed(c.gainPct, 0)}</b> 상승
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted">
                이 기준으로는 상승장 전환이 잡히지 않았습니다. 위에서 기준을 낮춰 보세요.
              </p>
            )}

            <div className="mt-4" ref={chartRef}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium">차트 봉</p>
                <TimeframeSelect value={tf} onChange={setTf} />
              </div>
              <p className="mb-2 text-[11px] leading-relaxed text-muted">
                {tf === "1d"
                  ? "주봉·월봉으로 바꿔도 성적표는 일봉 채점입니다."
                  : <>지금은 <b className="text-white">{CHART_TF_LABEL[tf]}</b>으로 봅니다. 성적표의 켜짐·적중은 일봉 채점 그대로입니다.</>}
              </p>
              {crypto ? <div className="mb-2"><BtcSpotHeader ticker={report.ticker} /></div> : null}

              {/* 지표 하나씩 고르기 — 30개를 다 겹치면 아무것도 안 보인다 */}
              <div className="mb-2 rounded-xl border border-border bg-bg p-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => stepSignal(-1)}
                    aria-label="이전 지표"
                    className="shrink-0 rounded-lg border border-border px-2.5 py-2 text-sm text-muted"
                  >
                    ‹
                  </button>
                  <select
                    value={selectedKey ?? ""}
                    onChange={(e) => setSelectedKey(e.target.value || null)}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-2 text-sm"
                  >
                    <option value="">지표 없음 (캔들만)</option>
                    {SIGNAL_GROUPS.map((g) => {
                      const inGroup = report.signals.filter((sig) => sig.group === g);
                      if (!inGroup.length) return null;
                      return (
                        <optgroup key={g} label={g}>
                          {inGroup.map((sig) => (
                            <option key={sig.key} value={sig.key}>
                              {sig.currentlyOn ? "● " : "○ "}
                              {sig.label} · {sig.hitCount}/{report.cycles.length}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                  <button
                    type="button"
                    onClick={() => stepSignal(1)}
                    aria-label="다음 지표"
                    className="shrink-0 rounded-lg border border-border px-2.5 py-2 text-sm text-muted"
                  >
                    ›
                  </button>
                </div>
                {selectedSignal ? (
                  <p className="mt-2 px-0.5 text-[11px] leading-relaxed text-muted">
                    <b className="text-white">
                      {report.signals.findIndex((sig) => sig.key === selectedSignal.key) + 1}위
                    </b>{" "}
                    · {plot?.rule || selectedSignal.why} · 지금{" "}
                    <b className={selectedSignal.currentlyOn ? "text-up" : "text-muted"}>
                      {selectedSignal.currentlyOn ? "켜짐" : "꺼짐"}
                    </b>
                    <br />
                    과거 상승장 시작 {report.cycles.length}번 중{" "}
                    <b className="text-white">{selectedSignal.hitCount}번</b> 적중(
                    {selectedSignal.hitRate == null ? "—" : `${selectedSignal.hitRate.toFixed(0)}%`}) · 신호{" "}
                    {selectedSignal.eventCount}회 · 우연일 확률{" "}
                    <b
                      className={
                        selectedSignal.chance == null
                          ? "text-muted"
                          : selectedSignal.chance < 0.05
                            ? "text-up"
                            : selectedSignal.chance < 0.2
                              ? "text-white"
                              : "text-down"
                      }
                    >
                      {selectedSignal.chance == null
                        ? "—"
                        : selectedSignal.chance < 0.001
                          ? "0.1% 미만"
                          : `${(selectedSignal.chance * 100).toFixed(selectedSignal.chance < 0.1 ? 1 : 0)}%`}
                    </b>
                  </p>
                ) : (
                  <p className="mt-2 px-0.5 text-[11px] text-muted">
                    지표를 고르면 그 지표의 선과 신호 발생일(노란 점)이 차트에 그려집니다.
                  </p>
                )}
              </div>

              <CycleChart
                series={viewSeries}
                troughDates={troughDates}
                peakDates={peakDates}
                signalDates={snappedMarkers}
                matchedSignalDates={snappedMatched}
                plot={plot}
                tf={tf}
              />

              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                초록 화살표 = 상승장 시작, 빨간 화살표 = 고점.
                {selectedSignal ? (
                  <>
                    {" "}
                    <b className="text-amber-300">노란 점</b> = 상승장 시작 부근에서 뜬 신호{" "}
                    {matchedDates.length}회
                    {markersTrimmed ? (
                      <>
                        . 이 지표는 전체 {selectedSignal.eventCount}회로 너무 자주 떠서 나머지는
                        표시하지 않았습니다(그만큼 잘 속는다는 뜻입니다 — 우연대비{" "}
                        {selectedSignal.lift?.toFixed(2) ?? "—"}배).
                      </>
                    ) : (
                      <>
                        , 회색 점 = 그 밖의 신호 {selectedSignal.eventCount - matchedDates.length}회
                        (전체 {selectedSignal.eventCount}회).
                      </>
                    )}
                  </>
                ) : null}
              </p>

              {crypto ? (
                <div className="mt-3">
                  <TradingViewChart
                    symbol={toTradingViewSymbol(report.ticker)}
                    interval={CHART_TF_TV[tf]}
                    caption={`${toTradingViewSymbol(report.ticker)} 현물 지수입니다. 바이낸스 무기한 선물(.P)이 아닙니다.`}
                  />
                </div>
              ) : null}
            </div>
          </section>

          {/* 공통 지표 */}
          <section className="rounded-2xl border border-up/30 bg-up/5 p-4">
            <h2 className="text-sm font-semibold">
              적중률 100% ({report.cycles.length}/{report.cycles.length})
            </h2>
            {commonSignals.length ? (
              <ul className="mt-2.5 space-y-1.5">
                {commonSignals.map((s) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => showSignal(s.key)}
                      className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-sm active:bg-bg"
                    >
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${s.currentlyOn ? "bg-up" : "bg-border"}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    <span className="shrink-0 text-[11px] text-muted">
                      {s.medianLeadDays == null
                        ? "—"
                        : s.medianLeadDays >= 0
                          ? `${s.medianLeadDays}일 늦게`
                          : `${Math.abs(s.medianLeadDays)}일 먼저`}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">
                      {s.currentlyOn ? "켜짐" : "꺼짐"}
                    </span>
                    <span aria-hidden className="shrink-0 text-[11px] text-muted">
                      📈
                    </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">
                모든 전환을 빠짐없이 잡은 지표는 없습니다. 아래 성적표에서 적중률 순으로 보세요.
              </p>
            )}
          </section>

          <CycleSignalTable report={report} selectedKey={selectedKey} onSelect={showSignal} />

          {/* 경고 */}
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
            <h2 className="text-sm font-semibold text-amber-300">
              읽기 전에 · 신뢰도 {report.reliability}
            </h2>
            <ul className="mt-2 space-y-1.5">
              {report.warnings.map((w) => (
                <li key={w} className="text-[11px] leading-relaxed text-amber-200/90">
                  · {w}
                </li>
              ))}
            </ul>
          </section>

          <button
            type="button"
            onClick={() => {
              clearCycle();
              setPayload(null);
              setSelectedKey(null);
              setTf("1d");
            }}
            className="w-full rounded-xl border border-border bg-surface py-3 text-sm text-muted"
          >
            결과 지우기
          </button>
        </div>
      ) : null}

      <p className="fixed inset-x-0 bottom-0 border-t border-border bg-bg/95 py-3 text-center text-xs text-muted backdrop-blur">
        과거 패턴이며 투자 판단의 근거가 아닙니다.
      </p>
    </main>
  );
}
