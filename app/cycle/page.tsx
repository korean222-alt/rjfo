"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BtcSpotHeader from "@/components/BtcSpotHeader";
import CycleSignalTable from "@/components/CycleSignalTable";
import { GradeBadge, TimingChip, chancePct, chanceTone, leadText, qTone } from "@/components/SignalMeta";
import NavTabs from "@/components/NavTabs";
import PositionPanel from "@/components/PositionPanel";
import TickerInput from "@/components/TickerInput";
import TimeframeSelect from "@/components/TimeframeSelect";
import { SIGNAL_GROUPS, completedStarts, factsForLlm, snapshotOnPct } from "@/lib/cycle";
import { enrichForPlot, plotForView } from "@/lib/cycle/plot";
import {
  barsForView,
  CHART_TF_LABEL,
  CHART_TF_TV,
  snapDatesToView,
  type ChartTf,
} from "@/lib/cycle/resample";
import { askCycle, runCycle, type CyclePayload } from "@/lib/cycle-client";
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
  const [busy, setBusy] = useState<null | "analyze" | "fallback">(null);
  const [error, setError] = useState<string | null>(null);
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tuning, setTuning] = useState(false);
  const [bearPct, setBearPct] = useState<number | null>(null);
  const [bullPct, setBullPct] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  /** 후속 질문과 답. 리포트를 다시 계산하지 않고 이 자리에서만 주고받는다. */
  const [qa, setQa] = useState<{ q: string; a: string; model: string | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
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
    async (rawTicker?: string, extra?: { bearPct?: number; bullPct?: number }) => {
      setError(null);
      setTickerError(null);
      const t = normalizeTicker(rawTicker ?? ticker);
      if (!t) return setTickerError("티커를 입력해 주세요.");
      if (!isValidTicker(t)) return setTickerError("올바른 티커 형식이 아닙니다.");

      setBusy("analyze");
      try {
        const next = await runCycle(
          {
            ticker: t,
            bearPct: extra?.bearPct ?? bearPct ?? undefined,
            bullPct: extra?.bullPct ?? bullPct ?? undefined,
          },
          () => setBusy("fallback"),
        );
        setPayload(next);
        setTicker(next.report.ticker);
        setBearPct(next.report.thresholds.bearPct);
        setBullPct(next.report.thresholds.bullPct);
        setSelectedKey(null);
        setQa(null);
        setAskError(null);
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

  /**
   * 후속 질문. 분석을 다시 돌리지 않고, 이미 가진 리포트의 FACTS만 보낸다.
   * (예전에는 여기서 /api/cycle을 통째로 다시 불러서 무엇을 물어도 같은 요약이 나왔다.)
   */
  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || !report) return;
    setAsking(true);
    setAskError(null);
    try {
      const { answer, model } = await askCycle(q, factsForLlm(report));
      setQa({ q, a: answer, model });
      setQuestion("");
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setAsking(false);
    }
  }, [question, report]);

  /** 성적표(단일) + 조합. 조합은 그릴 선이 없어 마커만 찍힌다. */
  const allSignals = useMemo(
    () => (report ? [...report.signals, ...report.combos] : []),
    [report],
  );

  const selectedSignal = useMemo(
    () => (selectedKey ? allSignals.find((s) => s.key === selectedKey) ?? null : null),
    [allSignals, selectedKey],
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
      if (!allSignals.length) return;
      const list = allSignals;
      const at = selectedKey ? list.findIndex((s) => s.key === selectedKey) : -1;
      const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
      setSelectedKey(list[next].key);
    },
    [allSignals, selectedKey],
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
    () => selectedSignal?.inWindowEvents ?? [],
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

  /**
   * 매수 근거가 있는 신호 = 여섯 관문을 다 통과한 것(A).
   * 하나도 없으면 그 사실을 그대로 보여준다. 억지로 순위 1위를 추천하지 않는다.
   */
  const buySignals = useMemo(
    () =>
      allSignals
        .filter((s) => s.grade === "A")
        .sort((a, b) => (a.qValue ?? 1) - (b.qValue ?? 1)),
    [allSignals],
  );

  /**
   * 관문별로 몇 개가 걸렸는지.
   *
   * "A등급이 하나도 없다"만 보여주면 사용자는 그게 결론인지 고장인지 알 수 없다.
   * 삼성전자처럼 0개가 나오는 종목에서 어느 관문이 막았는지(대개 표본이 적어
   * 앞뒤 기간을 못 나누는 ④번) 보여주면 그게 판정이라는 걸 알 수 있다.
   */
  const gateBlockers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of allSignals) {
      for (const c of s.checks) {
        if (!c.ok) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
      }
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [allSignals]);

  /** 같은 q값이 여러 개면 그건 '서로 구분이 안 된다'는 뜻이다 (BH 보정에서 묶인 것). */
  const qTied = useMemo(() => {
    const q = buySignals.map((s) => s.qValue).filter((v): v is number => v != null);
    if (q.length < 2) return false;
    return new Set(q.map((v) => v.toFixed(4))).size < q.length;
  }, [buySignals]);
  const nearMiss = useMemo(
    () => allSignals.filter((s) => s.grade === "B").sort((a, b) => (a.qValue ?? 1) - (b.qValue ?? 1)),
    [allSignals],
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
                상승장 시작으로 봅니다. 코인은 기본 -40%/+80%, 주식은 -20%/+40%입니다. 기준을 낮추면
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
              : "상승장 지표 찾기"}
        </button>
      </div>

      {report && payload ? (
        <div className="mt-6 space-y-4">
          {/* AI 요약 */}
          <section className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">AI 요약</h2>
              <span className="text-[10px] text-muted">
                {payload.model ? `Gemini ${payload.model}` : "AI 없이 계산 결과만"}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed">{payload.reply}</p>
            {qa ? (
              <div className="mt-3 rounded-xl border border-border bg-bg px-3 py-2.5">
                <p className="text-[11px] text-muted">Q. {qa.q}</p>
                <p className="mt-1 text-sm leading-relaxed">{qa.a}</p>
                {qa.model ? (
                  <p className="mt-1.5 text-[10px] text-muted">Gemini {qa.model}</p>
                ) : null}
              </div>
            ) : null}

            {askError ? (
              <p className="mt-2 rounded-xl border border-down/40 bg-down/10 px-3 py-2 text-[11px] text-down">
                {askError}
              </p>
            ) : null}

            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void ask();
              }}
            >
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="예: 지금 켜진 A등급 신호가 뭐야?"
                className="min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-muted"
              />
              <button
                type="submit"
                disabled={asking || !question.trim()}
                className="shrink-0 rounded-xl bg-blue-500 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                {asking ? "…" : "물어보기"}
              </button>
            </form>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
              이 화면에 이미 계산된 숫자만 보고 답합니다. 종목을 다시 분석하지 않습니다.
            </p>
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

          {/* 지금 위치 — 등급표가 답하지 못하는 "이미 많이 오른 상태인가"를 잰다 */}
          {report.position ? (
            <PositionPanel
              position={report.position}
              bearPct={report.thresholds.bearPct}
              windowAfter={report.window.after}
            />
          ) : null}

          {/* 매수 근거가 있는 신호 */}
          <section className="rounded-2xl border border-up/30 bg-up/5 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">사도 될 근거가 있는 신호</h2>
              <span className="text-xs text-muted">여섯 관문 전부 통과</span>
            </div>
            {/* 채점의 자(사이클 수·창 비율)를 먼저 보여준다. 이게 종목마다 달라서
                A등급 개수는 종목끼리 비교할 수 없다. */}
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              이 종목의 자: 상승장 전환 <b className="text-white">{report.cycles.length}번</b> · &lsquo;시작 부근&rsquo;이 전체의{" "}
              <b className="text-white">{report.windowSharePct.toFixed(0)}%</b>
              {report.windowShrunk ? (
                <>
                  {" "}
                  (사이클이 잦아 창을 {report.windowRequested.after}→{report.window.after}거래일로 줄임)
                </>
              ) : null}{" "}
              · 우연대비 천장 {(100 / Math.max(1, report.windowSharePct)).toFixed(1)}배
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-300/80">
              A등급 <b>개수</b>는 종목끼리 비교하지 마세요. 사이클이 3번 이하면 앞뒤 기간을 못 나눠 관문 ④에서 전부
              떨어지고(그 종목이 나쁜 게 아닙니다), 너무 잦으면 창이 넓어져 관문 ②가 막힙니다. 같은 모양의 시세로
              주기만 바꿔도 A등급 개수가 크게 요동칩니다.
            </p>

            {buySignals.length ? (
              <ul className="mt-2.5 space-y-1.5">
                {buySignals.map((s) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => showSignal(s.key)}
                      className="w-full rounded-lg px-1 py-1 text-left active:bg-bg"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={`h-2 w-2 shrink-0 rounded-full ${s.currentlyOn ? "bg-up" : "bg-border"}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">{s.label}</span>
                        <GradeBadge grade={s.grade} passCount={s.passCount} />
                        <span
                          className={`shrink-0 text-[11px] ${s.currentlyOn ? "text-up" : "text-muted"}`}
                        >
                          {s.currentlyOn ? "지금 켜짐" : "꺼짐"}
                        </span>
                        <span aria-hidden className="shrink-0 text-[11px] text-muted">
                          📈
                        </span>
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-3 pl-4 text-[11px] text-muted">
                        <TimingChip timing={s.timing} />
                        <span>
                          적중 {s.hitCount}/{report.cycles.length}
                        </span>
                        <span>리드 {leadText(s.medianLeadDays)}</span>
                        <span>
                          남은상승{" "}
                          {s.medianCaptureSharePct == null
                            ? "—"
                            : `${s.medianCaptureSharePct.toFixed(0)}%`}
                        </span>
                        <span className={qTone(s.qValue)}>보정후 {chancePct(s.qValue)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-muted">
                여섯 관문을 다 통과한 신호가 <b className="text-white">없습니다</b>. 이 종목·이 기간에서는
                &lsquo;이거 뜨면 사도 된다&rsquo;고 말할 근거가 데이터에 없다는 뜻입니다.
                {nearMiss.length ? (
                  <>
                    {" "}
                    하나만 못 넘긴 신호(B등급)는 {nearMiss.length}개 있습니다: {nearMiss.slice(0, 3).map((s) => s.label).join(", ")}
                    {nearMiss.length > 3 ? " 외" : ""}.
                  </>
                ) : null}
                {gateBlockers.length ? (
                  <span className="mt-2 block text-[11px] text-muted">
                    무엇이 막았나 (걸린 지표 수):{" "}
                    {gateBlockers.slice(0, 3).map(([label, n]) => `${label} ${n}개`).join(" · ")}
                    {report.cycles.length <= 3
                      ? " — 상승장 전환이 3번 이하라 앞뒤 기간 검증(관문 ④) 자체가 불가능합니다. 기준을 낮춰 사이클을 더 잡거나, 더 긴 데이터가 필요합니다."
                      : ""}
                  </span>
                ) : null}
              </p>
            )}

            {qTied ? (
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                위 신호들의 &lsquo;보정후&rsquo; 값이 같은 숫자로 겹칩니다. 다중검정 보정(q값)이 같은 구간으로 묶은 것이라,
                <b className="text-white"> 서로 우열을 가릴 수 없다</b>는 뜻입니다 — 각각 독립으로 증명된 게 아닙니다.
                게다가 조합은 구성 지표와 겹쳐 서로 독립이 아니므로, 이 값은 낙관적인 쪽입니다.
              </p>
            ) : null}

            <p className="mt-2.5 border-t border-border pt-2 text-[11px] leading-relaxed text-muted">
              여섯 관문: ① 다중검정 보정 후에도 우연이 아님 ② 아무 날이나 찍은 것보다 1.5배 이상 자주 상승장
              시작을 가리킴 ③ 신호 후 1년 수익률이 그냥 산 것보다 높음 ④ 앞 기간·뒤 기간 모두에서 통함
              ⑤ 상승장 시작을 절반 이상 잡음 ⑥ 떴을 때 그 사이클 상승분이 절반 이상 남아 있었음. 성적표에서
              지표를 누르면 관문별 통과 여부가 나옵니다.
            </p>
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
                    {report.combos.length ? (
                      <optgroup label="조합 (둘 다 켜짐)">
                        {report.combos.map((sig) => (
                          <option key={sig.key} value={sig.key}>
                            {sig.currentlyOn ? "● " : "○ "}[{sig.grade}] {sig.label} ·{" "}
                            {sig.hitCount}/{report.cycles.length}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {SIGNAL_GROUPS.map((g) => {
                      const inGroup = report.signals.filter((sig) => sig.group === g);
                      if (!inGroup.length) return null;
                      return (
                        <optgroup key={g} label={g}>
                          {inGroup.map((sig) => (
                            <option key={sig.key} value={sig.key}>
                              {sig.currentlyOn ? "● " : "○ "}[{sig.grade}] {sig.label} ·{" "}
                              {sig.hitCount}/{report.cycles.length}
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
                      {selectedSignal.grade}등급 {selectedSignal.passCount}/6
                    </b>{" "}
                    · {plot?.rule || selectedSignal.why} · 지금{" "}
                    <b className={selectedSignal.currentlyOn ? "text-up" : "text-muted"}>
                      {selectedSignal.currentlyOn ? "켜짐" : "꺼짐"}
                    </b>
                    <br />
                    과거 상승장 시작 {report.cycles.length}번 중{" "}
                    <b className="text-white">{selectedSignal.hitCount}번</b> 적중(
                    {selectedSignal.hitRate == null ? "—" : `${selectedSignal.hitRate.toFixed(0)}%`})
                    {selectedSignal.alreadyOnCount
                      ? ` · 이미 켜짐 ${selectedSignal.alreadyOnCount}회(적중 아님)`
                      : ""}{" "}
                    · 신호 {selectedSignal.eventCount}회 · 우연일 확률{" "}
                    <b className={chanceTone(selectedSignal.chance)}>{chancePct(selectedSignal.chance)}</b>
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
              <>
                <ul className="mt-2.5 space-y-1.5">
                  {commonSignals.map((s) => (
                    <li key={s.key}>
                      <button
                        type="button"
                        onClick={() => showSignal(s.key)}
                        className="w-full rounded-lg px-1 py-1 text-left text-sm active:bg-bg"
                      >
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className={`h-2 w-2 shrink-0 rounded-full ${s.currentlyOn ? "bg-up" : "bg-border"}`}
                          />
                          <span className="min-w-0 flex-1 truncate">{s.label}</span>
                          <span className="shrink-0 text-sm font-bold">
                            {s.hitCount}/{report.cycles.length}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted">
                            {s.currentlyOn ? "켜짐" : "꺼짐"}
                          </span>
                          <span aria-hidden className="shrink-0 text-[11px] text-muted">
                            📈
                          </span>
                        </span>
                        <span className="mt-0.5 flex flex-wrap gap-x-3 pl-4 text-[11px] text-muted">
                          <span>
                            리드{" "}
                            {s.medianLeadDays == null
                              ? "—"
                              : s.medianLeadDays >= 0
                                ? `${s.medianLeadDays}일 늦게`
                                : `${Math.abs(s.medianLeadDays)}일 먼저`}
                          </span>
                          <span>신호 {s.eventCount}회</span>
                          <span className={chanceTone(s.chance)}>우연일 확률 {chancePct(s.chance)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-relaxed text-muted">
                  {report.cycles.length}번을 전부, 그 부근에서 <b className="text-white">새로 켜지면서</b> 잡은
                  지표입니다. 표본이 {report.cycles.length}번뿐이라 100%라는 숫자만으로는 부족합니다 —{" "}
                  <span className="text-up">우연일 확률이 초록불(20% 미만)</span>인지 같이 보세요.
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted">
                {report.cycles.length}번 전부를 새로 켜지면서 잡은 지표는 없습니다. 아래 성적표에서 적중률 순으로
                보세요.
              </p>
            )}
          </section>

          {/* 조합 신호 */}
          {report.combos.length ? (
            <section className="rounded-2xl border border-border bg-surface p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">조합 신호 (둘 다 켜지면)</h2>
                <span className="text-xs text-muted">{report.combos.length}개 중 상위 6</span>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                상위 지표들을 성격이 다른 것끼리 짝지어 &lsquo;둘 다 켜진 첫날&rsquo;을 신호로 채점했습니다.
                겹치면 신호가 줄어드는 대신 헛신호가 걸러집니다. 조합도 단일 지표와 같은 보정 풀에 넣었습니다.
              </p>
              <ul className="mt-2.5 space-y-1.5">
                {report.combos.slice(0, 6).map((s) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => showSignal(s.key)}
                      className="w-full rounded-lg border border-border bg-bg px-2.5 py-2 text-left active:bg-surface"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={`h-2 w-2 shrink-0 rounded-full ${s.currentlyOn ? "bg-up" : "bg-border"}`}
                        />
                        <span className="min-w-0 flex-1 text-[13px] leading-snug">{s.label}</span>
                        <GradeBadge grade={s.grade} passCount={s.passCount} />
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 pl-4 text-[11px] text-muted">
                        <TimingChip timing={s.timing} />
                        <span>
                          적중 {s.hitCount}/{report.cycles.length}
                        </span>
                        <span>신호 {s.eventCount}회</span>
                        <span>리드 {leadText(s.medianLeadDays)}</span>
                        <span>
                          남은상승{" "}
                          {s.medianCaptureSharePct == null
                            ? "—"
                            : `${s.medianCaptureSharePct.toFixed(0)}%`}
                        </span>
                        <span className={qTone(s.qValue)}>보정후 {chancePct(s.qValue)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

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
