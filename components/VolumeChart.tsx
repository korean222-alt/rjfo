"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

export type SeriesPoint = { date: string; close: number; volume: number };

type Props = {
  series: SeriesPoint[];
  matchDates: string[];
};

export default function VolumeChart({ series, matchDates }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !series.length) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#141a24" },
        textColor: "#8b97a8",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#232b39", style: LineStyle.Dotted },
        horzLines: { color: "#232b39", style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: "#232b39" },
      timeScale: { borderColor: "#232b39", timeVisible: false },
      crosshair: { mode: 1 },
      handleScale: { axisPressedMouseMove: false },
      width: el.clientWidth,
      height: 260,
    });
    chartRef.current = chart;

    const lineSeries = chart.addLineSeries({
      color: "#60a5fa",
      lineWidth: 2,
      priceLineVisible: false,
    });
    lineSeries.setData(
      series.map((p) => ({ time: p.date as unknown as UTCTimestamp, value: p.close })),
    );

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      color: "#2f3d52",
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });
    volumeSeries.setData(
      series.map((p) => ({ time: p.date as unknown as UTCTimestamp, value: p.volume })),
    );

    // 매칭일 마커
    const matched = new Set(matchDates);
    lineSeries.setMarkers(
      series
        .filter((p) => matched.has(p.date))
        .map((p) => ({
          time: p.date as unknown as UTCTimestamp,
          position: "belowBar" as const,
          color: "#22c55e",
          shape: "arrowUp" as const,
        })),
    );

    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [series, matchDates]);

  return (
    <div className="rounded-2xl border border-border bg-surface p-2">
      <div ref={containerRef} className="w-full" />
    </div>
  );
}
