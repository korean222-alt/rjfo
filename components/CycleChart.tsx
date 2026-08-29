"use client";

import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar } from "@/types";
import type { SignalPlot } from "@/lib/cycle/plot";

type Props = {
  series: Bar[];
  /** 상승장 시작(바닥)으로 라벨링된 날짜들. */
  troughDates: string[];
  /** 직전 고점들. */
  peakDates: string[];
  /** 지금 보고 있는 지표의 신호 발생일 (많으면 페이지에서 추려서 넘긴다). */
  signalDates?: string[];
  /** 그중 상승장 시작 부근에서 뜬 것. 눈에 띄게 그린다. */
  matchedSignalDates?: string[];
  /** 지금 보고 있는 지표 하나의 그림. 없으면 캔들만. */
  plot?: SignalPlot | null;
};

const BG = "#141a24";
const GRID = "#232b39";

/** 20년을 다 펼치면 캔들이 서브픽셀이 된다. 빠르게 좁혀 볼 수 있게. */
const RANGES: { label: string; span: number | null }[] = [
  { label: "전체", span: null },
  { label: "10년", span: 2520 },
  { label: "3년", span: 756 },
  { label: "1년", span: 252 },
];

function baseOptions(width: number, height: number, log: boolean) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: BG },
      textColor: "#a9b4c4",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: GRID, style: LineStyle.Dotted },
      horzLines: { color: GRID, style: LineStyle.Dotted },
    },
    rightPriceScale: {
      borderColor: GRID,
      // 20년을 한 화면에 놓으면 선형 축에서는 초기 구간이 바닥에 붙어 안 보인다.
      mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    },
    timeScale: {
      borderColor: GRID,
      // 기본 minBarSpacing(0.5)이면 20년치 5,000봉을 폭 300px에 담을 수 없어
      // fitContent가 최근 2~3년만 보여준다. 사이클 바닥이 화면 밖으로 나가면
      // 이 차트는 목적을 잃는다. 봉을 서브픽셀까지 압축할 수 있게 낮춘다.
      minBarSpacing: 0.005,
    },
    crosshair: { mode: CrosshairMode.Normal },
    handleScale: { axisPressedMouseMove: false },
    width,
    height,
  };
}

export default function CycleChart({
  series,
  troughDates,
  peakDates,
  signalDates = [],
  matchedSignalDates = [],
  plot = null,
}: Props) {
  const mainRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlayRefs = useRef<ISeriesApi<"Line">[]>([]);
  const paneChartRef = useRef<IChartApi | null>(null);

  const [log, setLog] = useState(true);
  /** 보여줄 거래일 수. null이면 전체. */
  const [span, setSpan] = useState<number | null>(null);

  const pane = plot?.pane ?? null;

  // ── 메인 캔들 차트 ──────────────────────────────────────────────
  useEffect(() => {
    const el = mainRef.current;
    if (!el || !series.length) return;

    const chart = createChart(el, baseOptions(el.clientWidth, 340, log));
    chartRef.current = chart;

    const candles = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceLineVisible: false,
    });
    candleRef.current = candles;

    candles.setData(
      series.map((b) => {
        // 자릿수를 줄여 보낸 값이라 high < max(open, close)가 될 수 있다. 캔들이 깨지지 않게 보정.
        const high = Math.max(b.open, b.close, b.high);
        const low = Math.min(b.open, b.close, b.low);
        return { time: b.date as unknown as UTCTimestamp, open: b.open, high, low, close: b.close };
      }),
    );

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      overlayRefs.current = [];
      candleRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [series, log]);

  // ── 보이는 기간 ────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !series.length) return;
    if (span == null) {
      chart.timeScale().fitContent();
      return;
    }
    const to = series.length - 1;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, to - span), to });
  }, [span, series, log]);

  // ── 마커 (상승장 시작 / 고점 / 선택한 지표의 신호) ─────────────
  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    const matched = new Set(matchedSignalDates);
    const markers: SeriesMarker<UTCTimestamp>[] = [
      ...peakDates.map((d) => ({
        time: d as unknown as UTCTimestamp,
        position: "aboveBar" as const,
        color: "#f87171",
        shape: "arrowDown" as const,
        text: "고점",
      })),
      ...troughDates.map((d) => ({
        time: d as unknown as UTCTimestamp,
        position: "belowBar" as const,
        color: "#34d399",
        shape: "arrowUp" as const,
        text: "상승장 시작",
      })),
      // 상승장 시작 부근에서 뜬 신호는 밝게, 나머지는 흐리게.
      // 같은 노랑으로 다 찍으면 "이 지표가 바닥을 잡았나"가 안 보인다.
      ...signalDates
        .filter((d) => !matched.has(d))
        .map((d) => ({
          time: d as unknown as UTCTimestamp,
          position: "belowBar" as const,
          color: "#6b7280",
          shape: "circle" as const,
          text: "",
        })),
      // 이 점들은 정의상 '상승장 시작' 화살표 바로 옆에 찍힌다. 글자를 넣으면
      // 화살표 라벨과 겹쳐서 둘 다 못 읽는다. 무슨 색이 무슨 뜻인지는 캡션에 있다.
      ...matchedSignalDates.map((d) => ({
        time: d as unknown as UTCTimestamp,
        position: "belowBar" as const,
        color: "#fbbf24",
        shape: "circle" as const,
        text: "",
      })),
    ].sort((a, b) => (String(a.time) < String(b.time) ? -1 : 1));
    candles.setMarkers(markers);
  }, [troughDates, peakDates, signalDates, matchedSignalDates, series, log]);

  // 패널이 붙으면 시간축이 위아래로 두 번 나온다. 위쪽은 감춘다.
  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { visible: !pane } });
  }, [pane, series, log]);

  // ── 선택한 지표의 오버레이 (가격 위에 겹치는 선) ───────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const s of overlayRefs.current) chart.removeSeries(s);
    overlayRefs.current = [];

    for (const line of plot?.overlays ?? []) {
      if (!line.data.length) continue;
      const s = chart.addLineSeries({
        color: line.color,
        lineWidth: (line.width ?? 1) as 1 | 2 | 3,
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData(
        line.data.map((p) => ({ time: p.date as unknown as UTCTimestamp, value: p.value })),
      );
      overlayRefs.current.push(s);
    }
  }, [plot, series, log]);

  // ── 별도 패널 (MACD, RSI처럼 가격과 단위가 다른 지표) ──────────
  //
  // lightweight-charts v4에는 진짜 멀티 패널이 없다. 차트를 하나 더 만들고
  // 시간축을 양방향으로 묶는 게 표준 방법이다.
  useEffect(() => {
    const el = paneRef.current;
    const main = chartRef.current;
    if (!el || !main || !pane) return;

    const chart = createChart(el, {
      ...baseOptions(el.clientWidth, 150, false),
      rightPriceScale: { borderColor: GRID, mode: PriceScaleMode.Normal },
    });
    paneChartRef.current = chart;

    let first: ISeriesApi<"Line"> | null = null;
    for (const line of pane.lines) {
      if (!line.data.length) continue;
      const s = chart.addLineSeries({
        color: line.color,
        lineWidth: (line.width ?? 1) as 1 | 2 | 3,
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      s.setData(
        line.data.map((p) => ({ time: p.date as unknown as UTCTimestamp, value: p.value })),
      );
      first ??= s;
    }
    for (const level of pane.levels) {
      first?.createPriceLine({
        price: level.value,
        color: "#5b6676",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: level.label,
      });
    }

    // 양방향 동기화. 가드가 없으면 서로를 계속 호출해 무한 루프가 된다.
    let syncing = false;
    const link = (from: IChartApi, to: IChartApi) => (range: LogicalRange | null) => {
      if (syncing || !range) return;
      syncing = true;
      to.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    };
    const toPane = link(main, chart);
    const toMain = link(chart, main);
    main.timeScale().subscribeVisibleLogicalRangeChange(toPane);
    chart.timeScale().subscribeVisibleLogicalRangeChange(toMain);

    const initial = main.timeScale().getVisibleLogicalRange();
    if (initial) chart.timeScale().setVisibleLogicalRange(initial);

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      main.timeScale().unsubscribeVisibleLogicalRangeChange(toPane);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(toMain);
      paneChartRef.current = null;
      chart.remove();
    };
  }, [pane, series, log]);

  const legend = [...(plot?.overlays ?? []), ...(pane?.lines ?? [])].filter((l) => l.data.length);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {legend.map((l) => (
            <span key={l.label} className="flex items-center gap-1 text-[11px] text-muted">
              <span
                aria-hidden
                className="inline-block h-0.5 w-3 rounded"
                style={{ background: l.color }}
              />
              {l.label}
            </span>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setSpan(r.span)}
              className={`rounded border px-1.5 py-1 text-[11px] ${
                span === r.span ? "border-blue-500 bg-blue-500/15 text-white" : "border-border bg-bg text-muted"
              }`}
            >
              {r.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setLog((v) => !v)}
            className="rounded border border-border bg-bg px-1.5 py-1 text-[11px] text-muted"
          >
            {log ? "로그" : "선형"}
          </button>
        </div>
      </div>

      <div ref={mainRef} className="rounded-2xl border border-border bg-surface p-1" />

      {pane ? (
        <div className="rounded-2xl border border-border bg-surface p-1">
          <p className="px-2 pt-1 text-[11px] text-muted">{pane.title}</p>
          <div ref={paneRef} />
        </div>
      ) : null}
    </div>
  );
}
