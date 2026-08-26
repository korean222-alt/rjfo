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
};

const MA_COLORS = ["#f59e0b", "#a78bfa", "#38bdf8", "#34d399"];

type Props = {
  series: SeriesPoint[];
  matchDates: string[];
  maPeriods?: number[];
};

export default function VolumeChart({ series, matchDates, maPeriods = [] }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !series.length) return;

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
      height: 360,
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
      scaleMargins: { top: 0.76, bottom: 0 },
    });
    volumeSeries.setData(
      series.map((p) => ({
        time: p.date as unknown as UTCTimestamp,
        value: p.volume,
        color: p.close >= (p.open ?? p.close) ? "rgba(34, 197, 94, 0.38)" : "rgba(239, 68, 68, 0.38)",
      })),
    );

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

    const matched = new Set(matchDates);
    const markers: SeriesMarker<UTCTimestamp>[] = series
      .filter((p) => matched.has(p.date))
      .map((p) => ({
        time: p.date as unknown as UTCTimestamp,
        position: "belowBar" as const,
        color: "#60a5fa",
        shape: "arrowUp" as const,
        text: "신호",
      }));
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
  }, [series, matchDates, maPeriods]);

  return (
    <section className="rounded-2xl border border-border bg-surface p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">캔들 차트 · 거래량</h2>
          <p className="mt-1 text-xs text-muted leading-relaxed">
            파란 화살표는 현재 조건에 매칭된 신호 날짜입니다.
            {maPeriods.length ? ` 노란/보라 선은 설정한 이평선(${maPeriods.join(", ")}일)입니다.` : ""}
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
