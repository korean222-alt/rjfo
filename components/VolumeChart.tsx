"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  LineStyle,
  createChart,
  type IChartApi,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import { smaLine } from "@/lib/ma";

export type SeriesPoint = {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume: number;
  funding?: number | null;
};

export type ChartMarker = {
  date: string;
  label?: string;
  color?: string;
  position?: "aboveBar" | "belowBar";
};

const MA_COLORS = ["#f59e0b", "#a78bfa", "#38bdf8", "#34d399"];

type Props = {
  series: SeriesPoint[];
  matchDates: string[];
  maPeriods?: number[];
  extraMarkers?: ChartMarker[];
};

export default function VolumeChart({ series, matchDates, maPeriods = [], extraMarkers = [] }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const hasFunding = series.some((p) => p.funding != null && Number.isFinite(p.funding));

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !series.length) return;

    const height = hasFunding ? 460 : 360;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#141a24" },
        textColor: "#a9b4c4",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#232b39", style: LineStyle.Dotted },
        horzLines: { color: "#232b39", style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: "#232b39" },
      timeScale: { borderColor: "#232b39", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      handleScale: { axisPressedMouseMove: false },
      width: el.clientWidth,
      height,
    });
    chartRef.current = chart;

    const candles = series.map((p) => {
      const open = Number.isFinite(p.open) ? (p.open as number) : p.close;
      const high = Number.isFinite(p.high) ? (p.high as number) : p.close;
      const low = Number.isFinite(p.low) ? (p.low as number) : p.close;
      return {
        time: p.date as unknown as UTCTimestamp,
        open,
        high: Math.max(open, high, p.close),
        low: Math.min(open, low, p.close),
        close: p.close,
      };
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceLineVisible: false,
    });
    candleSeries.setData(candles);

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: hasFunding ? 0.7 : 0.76, bottom: hasFunding ? 0.16 : 0 },
    });
    volumeSeries.setData(
      series.map((p) => ({
        time: p.date as unknown as UTCTimestamp,
        value: p.volume,
        color: p.close >= (p.open ?? p.close) ? "rgba(34, 197, 94, 0.38)" : "rgba(239, 68, 68, 0.38)",
      })),
    );

    if (hasFunding) {
      const fundingSeries = chart.addHistogramSeries({
        priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
        priceScaleId: "funding",
        title: "펀딩%",
      });
      fundingSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.86, bottom: 0 },
      });
      fundingSeries.setData(
        series
          .filter((p) => p.funding != null && Number.isFinite(p.funding))
          .map((p) => ({
            time: p.date as unknown as UTCTimestamp,
            value: p.funding as number,
            color: (p.funding as number) >= 0 ? "rgba(251, 146, 60, 0.85)" : "rgba(34, 211, 238, 0.85)",
          })),
      );
    }

    const uniquePeriods = [...new Set(maPeriods.filter((n) => Number.isFinite(n) && n >= 2))];
    for (let i = 0; i < uniquePeriods.length; i++) {
      const period = uniquePeriods[i];
      const line = smaLine(series, period);
      if (!line.length) continue;
      const seriesApi = chart.addLineSeries({
        color: MA_COLORS[i % MA_COLORS.length],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        title: `MA${period}`,
        crosshairMarkerVisible: false,
      });
      seriesApi.setData(line.map((p) => ({ time: p.date as unknown as UTCTimestamp, value: p.value })));
    }

    const byDate = new Map<string, ChartMarker>();
    for (const d of matchDates) {
      byDate.set(d, { date: d, label: "신호", color: "#60a5fa", position: "belowBar" });
    }
    for (const m of extraMarkers) {
      byDate.set(m.date, m);
    }
    const markers: SeriesMarker<UTCTimestamp>[] = series
      .filter((p) => byDate.has(p.date))
      .map((p) => {
        const m = byDate.get(p.date)!;
        const position = (m.position ?? "belowBar") as "aboveBar" | "belowBar";
        return {
          time: p.date as unknown as UTCTimestamp,
          position,
          color: m.color ?? "#60a5fa",
          shape: (position === "aboveBar" ? "arrowDown" : "arrowUp") as "arrowDown" | "arrowUp",
          text: m.label ?? "신호",
        };
      });
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    candleSeries.setMarkers(markers);

    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [series, matchDates, maPeriods, extraMarkers, hasFunding]);

  return (
    <section className="rounded-2xl border border-border bg-surface p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{hasFunding ? "캔들 · 거래량 · 펀딩비" : "캔들 차트 · 거래량"}</h2>
          <p className="mt-1 text-xs text-muted leading-relaxed">
            화살표는 조건에 걸린 날입니다.
            {hasFunding ? " 맨 아래 주황/청록 막대가 일평균 펀딩비(%)입니다." : ""}
            {maPeriods.length ? ` 선은 이평선(${maPeriods.join(", ")}일)입니다.` : ""}
          </p>
        </div>
        <a
          href="https://www.tradingview.com/lightweight-charts/"
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs font-medium text-muted underline underline-offset-2"
        >
          Charting by TradingView
        </a>
      </div>
      <div ref={containerRef} className="w-full" />
    </section>
  );
}
