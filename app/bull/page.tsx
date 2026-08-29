"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TabNav from "@/components/TabNav";
import TickerInput from "@/components/TickerInput";
import { runBull, type BullPayload } from "@/lib/bull-client";
import { TF_CONFIG, VERDICT_LABEL, type BullIndicator, type Verdict } from "@/lib/bull";
import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { loadBullDraft, saveBullDraft } from "@/lib/session";
import {
  TIMEFRAMES,
  TIMEFRAME_INTERVAL,
  TIMEFRAME_LABEL,
  TIMEFRAME_UNIT,
  toTimeframe,
  type Timeframe,
} from "@/lib/timeframe";
import { toTradingViewSymbol } from "@/lib/tradingview";
import type { TvStudy } from "@/components/TradingViewChart";

const TradingViewChart = dynamic(() => import("@/components/TradingViewChart"), {
  ssr: false,
  loading: () => <div className="h-[520px] rounded-2xl border border-border bg-surface" />,
});

const DEFAULT_TICKER = "BTC";

/** 봉마다 지표 기간이 다르므로 차트에 올리는 이평선도 같이 바뀐다. */
function studiesFor(tf: Timeframe): TvStudy[] {
  const cfg = TF_CONFIG[tf];
  return [
    { id: "MASimple@tv-basicstudies", inputs: { length: cfg.maShort } },
    { id: "MASimple@tv-basicstudies", inputs: { length: cfg.maMid } },
    { id: "MASimple@tv-basicstudies", inputs: { length: cfg.maLong } },
    { id: "RSI@tv-basicstudies", inputs: { length: 14 } },
  ];
}

const VERDICT_STYLE: Record<Verdict, { dot: string; text: string; chip: string }> = {
  bullish: { dot: "bg-up", text: "text-up", chip: "border-up/40 bg-up/10 text-up" },
  neutral: { dot: "bg-flat", text: "text-muted", chip: "border-border bg-bg text-muted" },
  bearish: { dot: "bg-down", text: "text-down", chip: "border-down/40 bg-down/10 text-down" },
};

export default function BullPage() {
  const [ticker, setTicker] = useState(DEFAULT_TICKER);
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");
  const [payload, setPayload] = useState<BullPayload | null>(null);
  const [busy, setBusy] = useState<null | "load" | "fallback">(null);
  const [error, setError] = useState<string | null>(null);
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // 조회 중인 요청이 늦게 도착해 최신 결과를 덮어쓰지 않도록 순번을 센다.
  const reqId = useRef(0);

  useEffect(() => {
    const draft = loadBullDraft();
    if (draft) {
      setTicker(draft.ticker || DEFAULT_TICKER);
      setTimeframe(toTimeframe(draft.timeframe));
    }
    setHydrated(true);
  }, []);

  const load = useCallback(async (rawTicker: string, tf: Timeframe) => {
    const t = normalizeTicker(rawTicker);
    if (!t) {
      setTickerError("티커를 입력해 주세요.");
      return;
    }
    if (!isValidTicker(t)) {
      setTickerError("올바른 티커 형식이 아닙니다.");
      return;
    }
    setTickerError(null);
    setError(null);

    const id = ++reqId.current;
    setBusy("load");
    try {
      const data = await runBull(t, tf, {
        onFallback: () => {
          if (reqId.current === id) setBusy("fallback");
        },
      });
      if (reqId.current !== id) return;
      setPayload(data);
    } catch (e) {
      if (reqId.current !== id) return;
      setError((e as Error).message);
      setPayload(null);
    } finally {
      if (reqId.current === id) setBusy(null);
    }
  }, []);

  // 티커가 확정된 뒤부터는 봉을 바꿀 때마다 자동으로 다시 계산한다.
  useEffect(() => {
    if (!hydrated) return;
    saveBullDraft({ ticker, timeframe });
    load(ticker, timeframe);
    // 티커는 "조회" 버튼으로만 반영한다 (타이핑 중 매번 요청하지 않도록).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, timeframe]);

  const report = payload?.report ?? null;

  // 차트는 지표 응답을 기다리지 않는다 (입력한 티커로 바로 그린다).
  const symbol = useMemo(
    () => payload?.symbol ?? toTradingViewSymbol(normalizeTicker(ticker) || DEFAULT_TICKER),
    [payload, ticker],
  );
  const studies = useMemo(() => studiesFor(timeframe), [timeframe]);
  const cfg = TF_CONFIG[timeframe];
  const unit = TIMEFRAME_UNIT[timeframe];

  return (
    <main className="mx-auto max-w-lg px-4 py-8 pb-24">
      <TabNav />

      <header className="mb-6">
        <h1 className="text-2xl font-black">상승장 지표</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          지금이 오르는 국면인지 지표별로 따로 판정하고 점수로 묶습니다. 봉마다 기준이 다르므로
          일봉·주봉·월봉을 각각 보세요.
        </p>
      </header>

      <section className="mb-4 space-y-4 rounded-2xl border border-border bg-surface p-4">
        <TickerInput value={ticker} onChange={setTicker} error={tickerError} />
        <button
          type="button"
          onClick={() => {
            saveBullDraft({ ticker, timeframe });
            load(ticker, timeframe);
          }}
          disabled={busy !== null}
          className="w-full rounded-xl bg-blue-500 py-3 text-sm font-bold text-white transition active:scale-[0.99] disabled:opacity-50"
        >
          {busy === "load"
            ? "지표 계산 중…"
            : busy === "fallback"
              ? "시세 직접 받아오는 중…"
              : "이 티커로 보기"}
        </button>
      </section>

      <div
        className="mb-4 flex gap-1 rounded-xl border border-border bg-surface p-1"
        role="tablist"
        aria-label="봉 선택"
      >
        {TIMEFRAMES.map((tf) => {
          const on = tf === timeframe;
          return (
            <button
              key={tf}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTimeframe(tf)}
              className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                on ? "bg-blue-500/20 text-white" : "text-muted"
              }`}
            >
              {TIMEFRAME_LABEL[tf]}
            </button>
          );
        })}
      </div>

      <p className="mb-4 rounded-xl border border-border bg-surface px-4 py-3 text-xs leading-relaxed text-muted">
        <span className="font-semibold text-white">{TIMEFRAME_LABEL[timeframe]} 기준</span> — 이평{" "}
        {cfg.maShort}/{cfg.maMid}/{cfg.maLong}
        {unit}, 모멘텀 {cfg.momentumSpan}봉, 고점 비교 {cfg.highWindow}봉. 차트의 이평선도 같은
        기간으로 올라갑니다.
      </p>

      <div className="mb-4">
        <TradingViewChart
          symbol={symbol}
          interval={TIMEFRAME_INTERVAL[timeframe]}
          studies={studies}
          height={520}
          caption={`${TIMEFRAME_LABEL[timeframe]} · 이평 ${cfg.maShort}/${cfg.maMid}/${cfg.maLong} · RSI(14)`}
        />
      </div>

      {error ? (
        <p className="mb-4 rounded-xl border border-down/40 bg-down/10 px-4 py-3 text-sm text-down">
          {error}
        </p>
      ) : null}

      {report ? (
        <>
          <section className="mb-4 rounded-2xl border border-border bg-surface p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-muted">
                  {report.ticker} · {TIMEFRAME_LABEL[report.timeframe]} · {report.asOf} 기준
                  {report.inProgress ? " (진행 중)" : ""}
                </p>
                <p
                  className={`mt-1 text-2xl font-black ${
                    report.score >= 60 ? "text-up" : report.score < 40 ? "text-down" : "text-white"
                  }`}
                >
                  {report.verdict}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-4xl font-black tabular-nums">{report.score}</p>
                <p className="text-xs text-muted">100점 만점</p>
              </div>
            </div>

            <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-bg">
              <span
                className="bg-up"
                style={{ width: `${(report.bullish / report.indicators.length) * 100}%` }}
              />
              <span
                className="bg-flat/50"
                style={{ width: `${(report.neutral / report.indicators.length) * 100}%` }}
              />
              <span
                className="bg-down"
                style={{ width: `${(report.bearish / report.indicators.length) * 100}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              지표 {report.indicators.length}개 중 상승 {report.bullish} · 중립 {report.neutral} ·
              하락 {report.bearish} · {TIMEFRAME_LABEL[report.timeframe]} {report.barCount}개로 계산
            </p>
          </section>

          <ul className="space-y-2">
            {report.indicators.map((ind) => (
              <IndicatorRow key={ind.key} indicator={ind} />
            ))}
          </ul>

          {report.notes.map((note) => (
            <p
              key={note}
              className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-200"
            >
              {note}
            </p>
          ))}
        </>
      ) : busy ? (
        <p className="rounded-xl border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
          지표를 계산하고 있습니다…
        </p>
      ) : null}

      <p className="mt-8 text-center text-xs text-muted">
        과거·현재 지표이며 투자 판단의 근거가 아닙니다.
      </p>
    </main>
  );
}

function IndicatorRow({ indicator }: { indicator: BullIndicator }) {
  const style = VERDICT_STYLE[indicator.verdict];
  return (
    <li className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
          <p className="truncate text-sm font-semibold">{indicator.label}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-sm font-bold tabular-nums ${style.text}`}>{indicator.value}</span>
          <span className={`rounded-full border px-2 py-0.5 text-xs ${style.chip}`}>
            {VERDICT_LABEL[indicator.verdict]}
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">{indicator.detail}</p>
    </li>
  );
}
