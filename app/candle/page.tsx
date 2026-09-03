"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EngineBar from "@/components/EngineBar";
import NavTabs from "@/components/NavTabs";
import TickerInput from "@/components/TickerInput";
import { GradeBadge, chancePct, qTone } from "@/components/SignalMeta";
import {
  CANDLE_HORIZONS,
  HORIZON_LABEL,
  factsForLlm,
  type GradedPattern,
} from "@/lib/candle";
import { askCandle, runCandle, type CandlePayload } from "@/lib/candle-client";
import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { modelLabel } from "@/lib/format";
import { loadCandle, saveCandle } from "@/lib/session";

const CycleChart = dynamic(() => import("@/components/CycleChart"), {
  ssr: false,
  loading: () => <div className="h-[320px] rounded-2xl border border-border bg-surface" />,
});

const EXAMPLES = ["BTC", "ETH", "NVDA", "TSLA", "005930"];

/** 캔들이 안 보일 만큼 점을 찍으면 차트가 쓸모없어진다. 최근 것부터 이만큼만. */
const MAX_MARKERS = 200;

function pct(n: number | null | undefined, digits = 0): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}%`;
}

function signed(n: number | null | undefined, digits = 2): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function pp(n: number | null | undefined, digits = 1): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%p`;
}

/** 기저보다 나으면 초록, 못하면 빨강. 표에서 이 색 하나로 판단이 끝나야 한다. */
function edgeTone(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "text-muted";
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-muted";
}

function BiasChip({ bias }: { bias: "상승" | "하락" }) {
  return (
    <span
      className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${
        bias === "상승" ? "bg-up/15 text-up" : "bg-down/15 text-down"
      }`}
    >
      {bias}형
    </span>
  );
}

export default function CandlePage() {
  const [ticker, setTicker] = useState("");
  const [payload, setPayload] = useState<CandlePayload | null>(null);
  const [busy, setBusy] = useState<null | "analyze" | "fallback">(null);
  const [error, setError] = useState<string | null>(null);
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [horizon, setHorizon] = useState<number>(5);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [question, setQuestion] = useState("");
  const [qa, setQa] = useState<{ q: string; a: string; model: string | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = loadCandle<CandlePayload>();
    if (!saved?.report) return;
    setPayload(saved);
    setTicker(saved.report.ticker);
    setHorizon(saved.report.horizon);
  }, []);

  // URL로 티커를 받으면(다른 화면이 보낸 링크) 바로 돌린다.
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
    async (rawTicker?: string, nextHorizon?: number) => {
      setError(null);
      setTickerError(null);
      const t = normalizeTicker(rawTicker ?? ticker);
      if (!t) return setTickerError("티커를 입력해 주세요.");
      if (!isValidTicker(t)) return setTickerError("올바른 티커 형식이 아닙니다.");

      setBusy("analyze");
      try {
        const next = await runCandle(
          { ticker: t, horizon: nextHorizon ?? horizon },
          () => setBusy("fallback"),
        );
        setPayload(next);
        setTicker(next.report.ticker);
        setHorizon(next.report.horizon);
        setSelectedKey(null);
        setQa(null);
        setAskError(null);
        saveCandle(next);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [horizon, ticker],
  );

  const report = payload?.report ?? null;

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || !report) return;
    setAsking(true);
    setAskError(null);
    try {
      const { answer, model } = await askCandle(q, factsForLlm(report));
      setQa({ q, a: answer, model });
      setQuestion("");
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setAsking(false);
    }
  }, [question, report]);

  const selected = useMemo(
    () => (report && selectedKey ? report.patterns.find((p) => p.key === selectedKey) ?? null : null),
    [report, selectedKey],
  );

  const markerDates = useMemo(
    () => (selected ? selected.occurrences.slice(-MAX_MARKERS) : []),
    [selected],
  );
  const winDates = useMemo(() => {
    if (!selected) return [];
    const shown = new Set(markerDates);
    return selected.winDates.filter((d) => shown.has(d));
  }, [selected, markerDates]);

  const showPattern = useCallback((key: string | null) => {
    setSelectedKey(key);
    if (key) chartRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /** 근거가 있는 패턴 = 여섯 관문을 다 통과한 것(A). 없으면 없다고 말한다. */
  const proven = useMemo(
    () => (report ? report.patterns.filter((p) => p.grade === "A") : []),
    [report],
  );
  const nearMiss = useMemo(
    () => (report ? report.patterns.filter((p) => p.grade === "B") : []),
    [report],
  );

  /** 관문별로 몇 개가 걸렸는지. A가 0개일 때 그게 판정이라는 걸 보여준다. */
  const gateBlockers = useMemo(() => {
    if (!report) return [];
    const counts = new Map<string, number>();
    for (const p of report.patterns) {
      for (const c of p.checks) if (!c.ok) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [report]);

  const visiblePatterns = useMemo(() => {
    if (!report) return [];
    return showAll ? report.patterns : report.patterns.slice(0, 12);
  }, [report, showAll]);

  const baseStat = report ? report.baseline.byHorizon[String(report.horizon)] : null;
  const lastBar = report?.read[report.read.length - 1] ?? null;

  return (
    <main className="mx-auto max-w-lg px-4 py-6 pb-32">
      <NavTabs />

      <header className="mb-6">
        <h1 className="text-2xl font-black">캔들 분석</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          티커를 넣으면 모든 봉을 하나씩 읽어 캔들 패턴을 찾아내고, 그 다음 며칠 동안 실제로 무슨 일이
          있었는지 전부 채점합니다. &lsquo;아무 날이나 샀을 때&rsquo;와 비교해 근거가 있는 모양만 남깁니다.
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

        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-sm font-medium">채점 구간</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            캔들이 뜬 날 종가에 사서 <b className="text-white">며칠 뒤</b> 종가에 판 것으로 채점합니다.
            구간을 바꾸면 성적이 바뀝니다 — 짧을수록 캔들의 영향이 크고, 길수록 추세에 묻힙니다.
          </p>
          <div className="mt-2 flex gap-1.5">
            {CANDLE_HORIZONS.map((h) => (
              <button
                key={h}
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setHorizon(h);
                  if (report) void run(report.ticker, h);
                }}
                className={`flex-1 rounded-lg border px-2 py-2 text-[11px] transition disabled:opacity-50 ${
                  horizon === h
                    ? "border-blue-500 bg-blue-500/15 text-white"
                    : "border-border bg-bg text-muted"
                }`}
              >
                {HORIZON_LABEL[h]}
              </button>
            ))}
          </div>
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
            ? "캔들 하나하나 채점 중…"
            : busy === "fallback"
              ? "시세 직접 받아오는 중…"
              : "캔들 패턴 분석"}
        </button>
      </div>

      {report && payload ? (
        <div className="mt-6 space-y-4">
          {/* AI 요약 */}
          <section className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">AI 요약</h2>
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                  payload.model
                    ? "border-blue-500/40 bg-blue-500/10 text-blue-200"
                    : "border-border text-muted"
                }`}
              >
                {payload.model ? modelLabel(payload.model) : "AI 없음 · 서버 요약문"}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed">{payload.reply}</p>
            {qa ? (
              <div className="mt-3 rounded-xl border border-border bg-bg px-3 py-2.5">
                <p className="text-[11px] text-muted">Q. {qa.q}</p>
                <p className="mt-1 text-sm leading-relaxed">{qa.a}</p>
                <p className="mt-1.5 text-[10px] text-muted">
                  {qa.model ? modelLabel(qa.model) : "AI 없음 · 서버 요약문"}
                </p>
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
                placeholder="예: 망치형은 진짜 잘 맞아?"
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
              <br />
              <b className="text-white">캔들 판독에는 AI가 필요 없습니다</b> — 봉 모양 인식, 패턴
              채점, 기저율 대비, 우연일 확률은 전부 서버 코드가 수식으로 계산합니다. AI는 그
              숫자를 문장으로 옮길 뿐이고, 꺼져 있으면 서버가 만든 요약문이 대신 나옵니다.
            </p>
          </section>

          {/* 지금 이 캔들 */}
          <section className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">지금 이 캔들</h2>
              <span className="text-xs text-muted">{report.outlook.date} 기준</span>
            </div>
            {lastBar ? (
              <>
                <p className="mt-2 text-2xl font-black">
                  {lastBar.shape}
                  <span className={`ml-2 text-base font-bold ${edgeTone(lastBar.changePct)}`}>
                    {signed(lastBar.changePct)}
                  </span>
                </p>
                <p className="mt-1 text-[11px] text-muted">
                  몸통 {pct(lastBar.bodyPct)} · 윗꼬리 {pct(lastBar.upperPct)} · 아랫꼬리{" "}
                  {pct(lastBar.lowerPct)} · 봉 크기 20일 평균의{" "}
                  {lastBar.rangeRatio == null ? "—" : `${lastBar.rangeRatio.toFixed(1)}배`} · 거래량{" "}
                  {lastBar.volumeRatio == null ? "—" : `${lastBar.volumeRatio.toFixed(1)}배`}
                </p>
              </>
            ) : null}

            <div className="mt-3 rounded-xl border border-border bg-bg px-3 py-2.5">
              <p className="text-xs font-semibold">
                전망:{" "}
                <span
                  className={
                    report.outlook.bias === "상승 우세"
                      ? "text-up"
                      : report.outlook.bias === "하락 우세"
                        ? "text-down"
                        : "text-muted"
                  }
                >
                  {report.outlook.bias}
                </span>
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{report.outlook.basis}</p>
              {report.outlook.expectedPct != null ? (
                <p className="mt-2 text-[11px] text-muted">
                  과거 평균{" "}
                  <b className={edgeTone(report.outlook.expectedPct)}>
                    {signed(report.outlook.expectedPct)}
                  </b>{" "}
                  · 방향 적중 <b className="text-white">{pct(report.outlook.successRate)}</b> · 기저 상승{" "}
                  <b className="text-white">{pct(report.outlook.baseUpRate)}</b>
                </p>
              ) : null}
            </div>

            {report.outlook.active.length ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {report.outlook.active.map((h) => (
                  <li key={`${h.key}-${h.daysAgo}`}>
                    <button
                      type="button"
                      onClick={() => showPattern(h.key)}
                      className="flex items-center gap-1.5 rounded border border-border bg-bg px-2 py-1 text-[11px] text-muted"
                    >
                      <GradeBadge grade={h.grade} passCount={h.passCount} />
                      {h.label}
                      <span className="opacity-60">{h.daysAgo === 0 ? "오늘" : `${h.daysAgo}일 전`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {/* 기준선 */}
          <section className="rounded-2xl border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold">기준선 (아무 날이나 샀을 때)</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              모든 적중률은 이 숫자와 비교해서 읽어야 합니다. 이 종목은 원래 잘 오르는 종목일 수도 있고,
              그렇다면 &lsquo;적중률 60%&rsquo;짜리 패턴은 아무것도 발견한 게 아닙니다.
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-muted">
                  <tr className="border-b border-border">
                    <th className="py-1.5 text-left font-normal">구간</th>
                    <th className="py-1.5 text-right font-normal">상승 확률</th>
                    <th className="py-1.5 text-right font-normal">평균</th>
                    <th className="py-1.5 text-right font-normal">중앙값</th>
                    <th className="py-1.5 text-right font-normal">최악</th>
                  </tr>
                </thead>
                <tbody>
                  {report.horizons.map((h) => {
                    const s = report.baseline.byHorizon[String(h)];
                    const active = h === report.horizon;
                    return (
                      <tr
                        key={h}
                        className={`border-b border-border/50 ${active ? "text-white" : "text-muted"}`}
                      >
                        <td className="py-1.5">
                          {HORIZON_LABEL[h] ?? `${h}일`}
                          {active ? <span className="ml-1 text-blue-400">●</span> : null}
                        </td>
                        <td className="py-1.5 text-right">{pct(s.upRate)}</td>
                        <td className="py-1.5 text-right">{signed(s.avg)}</td>
                        <td className="py-1.5 text-right">{signed(s.median)}</td>
                        <td className="py-1.5 text-right text-down">{signed(s.worst, 1)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* 근거 있는 패턴 */}
          <section className="rounded-2xl border border-up/30 bg-up/5 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">근거가 있는 캔들</h2>
              <span className="text-xs text-muted">여섯 관문 전부 통과</span>
            </div>
            {proven.length ? (
              <ul className="mt-2.5 space-y-1.5">
                {proven.map((p) => (
                  <li key={p.key}>
                    <button
                      type="button"
                      onClick={() => showPattern(p.key)}
                      className="w-full rounded-lg px-1 py-1 text-left active:bg-bg"
                    >
                      <span className="flex items-center gap-2">
                        <GradeBadge grade={p.grade} passCount={p.passCount} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.label}</span>
                        <BiasChip bias={p.bias} />
                      </span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {p.count}회 · 적중 {pct(p.successRate)} vs 기저 {pct(p.baseRate)} (
                        <b className={edgeTone(p.rateEdge)}>{pp(p.rateEdge)}</b>) · 평균{" "}
                        {signed(p.avgMovePct)} (기저 대비{" "}
                        <b className={edgeTone(p.edge)}>{pp(p.edge, 2)}</b>)
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p className="mt-2 text-sm leading-relaxed">
                  여섯 관문을 다 통과한 캔들 패턴이 <b>없습니다</b>. 이 종목·이 기간에서 &lsquo;이 모양이
                  나오면 오른다&rsquo;고 말할 근거는 데이터에 없습니다.
                </p>
                {gateBlockers.length ? (
                  <div className="mt-2 rounded-xl border border-border bg-bg px-3 py-2">
                    <p className="text-[11px] text-muted">어느 관문에서 걸렸나 (패턴 수)</p>
                    <ul className="mt-1 space-y-0.5">
                      {gateBlockers.map(([label, n]) => (
                        <li key={label} className="text-[11px] text-muted">
                          {label} <span className="text-white">{n}개</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {nearMiss.length ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted">
                    관문 하나만 못 넘은 패턴: {nearMiss.slice(0, 4).map((p) => p.label).join(", ")}
                    {nearMiss.length > 4 ? ` 외 ${nearMiss.length - 4}개` : ""}.
                  </p>
                ) : null}
              </>
            )}
          </section>

          {/* 차트 */}
          <section ref={chartRef} className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {selected ? selected.label : "차트"}
              </h2>
              <span className="text-[10px] text-muted">
                {selected ? `${selected.count}회 발생` : "패턴을 고르면 발생일이 찍힙니다"}
              </span>
            </div>
            <CycleChart
              series={payload.series}
              troughDates={[]}
              peakDates={[]}
              signalDates={markerDates}
              matchedSignalDates={winDates}
              tf="1d"
            />
            <p className="text-[10px] leading-relaxed text-muted">
              🟡 노란 점 = 그 뒤 {HORIZON_LABEL[report.horizon]} 동안 패턴이 가리킨 방향으로 간 경우 ·
              ⚪ 회색 점 = 반대로 간 경우.
              {selected && selected.occurrences.length > MAX_MARKERS
                ? ` 발생이 ${selected.count}회라 최근 ${MAX_MARKERS}개만 찍었습니다.`
                : ""}{" "}
              캔들 모양은 일봉 기준이라 주봉·월봉으로 바꿔 보여주지 않습니다 (봉을 합치면 모양이 달라집니다).
            </p>
          </section>

          {/* 선택한 패턴 상세 */}
          {selected ? <PatternDetail p={selected} horizon={report.horizon} /> : null}

          {/* 패턴 성적표 */}
          <section className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">캔들 성적표</h2>
              <span className="text-xs text-muted">{report.patterns.length}가지</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              순위는 &lsquo;기저보다 얼마나 더 맞혔나 + 더 벌었나 + 그게 우연이 아닌가&rsquo;를 합친 뒤
              표본이 모자란 만큼 눌러서 매깁니다 (한 번 떠서 한 번 맞은 패턴이 위로 오지 않게).
              두 열 모두 <b>그 패턴이 가리킨 방향</b> 기준이라, 하락형은 내렸을 때가 양수입니다.
              줄을 누르면 차트에 발생일이 찍힙니다.
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-muted">
                  <tr className="border-b border-border">
                    <th className="py-1.5 text-left font-normal">패턴</th>
                    <th className="py-1.5 text-right font-normal">발생</th>
                    <th className="py-1.5 text-right font-normal">적중−기저</th>
                    <th className="py-1.5 text-right font-normal">평균−기저</th>
                    <th className="py-1.5 text-right font-normal">q값</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePatterns.map((p) => (
                    <tr
                      key={p.key}
                      onClick={() => showPattern(p.key)}
                      className={`cursor-pointer border-b border-border/50 ${
                        selectedKey === p.key ? "bg-blue-500/10" : ""
                      }`}
                    >
                      <td className="py-1.5 pr-2">
                        <span className="flex items-center gap-1.5">
                          <GradeBadge grade={p.grade} passCount={p.passCount} />
                          <span className="min-w-0 truncate">{p.label}</span>
                          <BiasChip bias={p.bias} />
                        </span>
                      </td>
                      <td className="py-1.5 text-right text-muted">{p.count}</td>
                      <td className={`py-1.5 text-right ${edgeTone(p.rateEdge)}`}>{pp(p.rateEdge)}</td>
                      <td className={`py-1.5 text-right ${edgeTone(p.edge)}`}>{pp(p.edge, 2)}</td>
                      <td className={`py-1.5 text-right ${qTone(p.qValue)}`}>{chancePct(p.qValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.patterns.length > 12 ? (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="mt-2 w-full rounded-lg border border-border bg-bg py-2 text-[11px] text-muted"
              >
                {showAll ? "접기" : `나머지 ${report.patterns.length - 12}가지 더 보기`}
              </button>
            ) : null}
            <p className="mt-2 text-[10px] leading-relaxed text-muted">
              성적표에는 &lsquo;망치형&rsquo;(하락 뒤에 나온 것만)과 &lsquo;아랫꼬리 긴 봉&rsquo;(모양만 같고
              추세 조건 없음)이 같이 들어 있습니다. 둘을 비교하면 교과서가 강조하는 &lsquo;앞선 추세&rsquo;
              조건이 이 종목에서 실제로 의미가 있었는지 알 수 있습니다.
            </p>
          </section>

          {/* 캔들 하나하나 읽기 */}
          <section className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">캔들 하나하나 읽기</h2>
              <span className="text-xs text-muted">최근 {report.read.length}봉</span>
            </div>
            <ul className="mt-2 divide-y divide-border/50">
              {[...report.read].reverse().map((b) => (
                <li key={b.date} className="flex items-start gap-2 py-2">
                  <span className="w-[74px] shrink-0 text-[11px] text-muted">{b.date.slice(2)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <b className="text-[12px]">{b.shape}</b>
                      <span className={`text-[11px] ${edgeTone(b.changePct)}`}>{signed(b.changePct)}</span>
                      {b.volumeRatio != null && b.volumeRatio >= 2 ? (
                        <span className="text-[10px] text-amber-300">거래량 {b.volumeRatio.toFixed(1)}배</span>
                      ) : null}
                    </span>
                    {b.patterns.length ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {b.patterns.map((h) => (
                          <button
                            key={h.key}
                            type="button"
                            onClick={() => showPattern(h.key)}
                            className="flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] text-muted"
                          >
                            <GradeBadge grade={h.grade} passCount={h.passCount} />
                            {h.label}
                          </button>
                        ))}
                      </span>
                    ) : null}
                  </span>
                  <span className="w-[54px] shrink-0 text-right text-[11px]">
                    {b.forwardPct == null ? (
                      <span className="text-muted">진행중</span>
                    ) : (
                      <span className={edgeTone(b.forwardPct)}>{signed(b.forwardPct, 1)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] leading-relaxed text-muted">
              오른쪽 숫자는 그 봉 종가에 샀다면 {HORIZON_LABEL[report.horizon]} 뒤에 얼마였는지입니다.
              최근 {report.horizon}봉은 아직 그 미래가 오지 않아 &lsquo;진행중&rsquo;입니다.
            </p>
          </section>

          {/* 경고 */}
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
            <h2 className="text-sm font-semibold">이 숫자를 믿기 전에</h2>
            <ul className="mt-2 space-y-2">
              {report.warnings.map((w, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-muted">
                  · {w}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[10px] leading-relaxed text-muted">
              신뢰도 {report.reliability} · {report.periodStart}~{report.periodEnd} ·{" "}
              {report.totalBars}봉 · 채점 구간 {HORIZON_LABEL[report.horizon]}
            </p>
          </section>
        </div>
      ) : null}

      <EngineBar model={qa?.model ?? payload?.model ?? null} />
    </main>
  );
}

/** 패턴 하나의 상세: 무엇을 세었는지(조건), 관문 여섯 개, 구간별 성적. */
function PatternDetail({ p, horizon }: { p: GradedPattern; horizon: number }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <GradeBadge grade={p.grade} passCount={p.passCount} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{p.label}</h2>
        <BiasChip bias={p.bias} />
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{p.why}</p>
      <p className="mt-1 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[10px] leading-relaxed text-muted">
        판정 조건: {p.rule}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stat label="발생" value={`${p.count}회`} sub={`겹치지 않는 ${p.independentCount}회`} />
        <Stat
          label="방향 적중률"
          value={pct(p.successRate)}
          sub={`기저 ${pct(p.baseRate)} (${pp(p.rateEdge)})`}
          tone={edgeTone(p.rateEdge)}
        />
        <Stat
          label={`${HORIZON_LABEL[horizon] ?? `${horizon}일`} 평균`}
          value={signed(p.avgMovePct)}
          sub={`기저 ${signed(p.baseAvgMovePct)} → 방향 대비 ${pp(p.edge, 2)}`}
          tone={edgeTone(p.edge)}
        />
        <Stat
          label="역행폭 중앙값"
          value={pct(p.adverse.medianPct, 1)}
          sub={`평소 ${pct(p.baseAdverseMedianPct, 1)} · 최악 ${pct(p.adverse.worstPct, 1)}`}
        />
      </div>

      <ul className="mt-3 space-y-1">
        {p.checks.map((c) => (
          <li key={c.label} className="flex items-start gap-2 text-[11px]">
            <span className={c.ok ? "text-up" : "text-down"}>{c.ok ? "✓" : "✗"}</span>
            <span className="min-w-0 flex-1">
              <b className={c.ok ? "" : "text-muted"}>{c.label}</b>
              <span className="ml-1.5 text-muted">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="py-1.5 text-left font-normal">구간</th>
              <th className="py-1.5 text-right font-normal">평균</th>
              <th className="py-1.5 text-right font-normal">중앙값</th>
              <th className="py-1.5 text-right font-normal">상승 비율</th>
              <th className="py-1.5 text-right font-normal">최악</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(p.forward).map(([h, s]) => (
              <tr
                key={h}
                className={`border-b border-border/50 ${Number(h) === horizon ? "text-white" : "text-muted"}`}
              >
                <td className="py-1.5">{HORIZON_LABEL[Number(h)] ?? `${h}일`}</td>
                <td className="py-1.5 text-right">{signed(s.avg)}</td>
                <td className="py-1.5 text-right">{signed(s.median)}</td>
                <td className="py-1.5 text-right">{pct(s.upRate)}</td>
                <td className="py-1.5 text-right text-down">{signed(s.worst, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-muted">
        마지막 발생 {p.lastDate ?? "—"}
        {p.daysSinceLast != null ? ` (${p.daysSinceLast}거래일 전)` : ""} · 우연일 확률{" "}
        {chancePct(p.chance)} → 보정 후 <span className={qTone(p.qValue)}>{chancePct(p.qValue)}</span>
        {p.walkForward
          ? ` · 앞 기간 ${pp(p.walkForward.early.edge, 1)}(${p.walkForward.early.count}회) / 뒤 기간 ${pp(p.walkForward.late.edge, 1)}(${p.walkForward.late.count}회)`
          : " · 발생이 적어 앞뒤 기간을 못 나눔"}
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg px-3 py-2">
      <p className="text-[10px] text-muted">{label}</p>
      <p className={`text-base font-bold ${tone ?? ""}`}>{value}</p>
      {sub ? <p className="text-[10px] text-muted">{sub}</p> : null}
    </div>
  );
}
