"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";

export type CyclePoint = { date: string; close: number };

type Props = {
  series: CyclePoint[];
  /** 상승장 시작(바닥)으로 라벨링된 날짜들. */
  troughDates: string[];
  /** 직전 고점들. */
  peakDates: string[];
  /** 지금 보고 있는 지표의 신호 발생일. */
  signalDates?: string[];
  signalLabel?: string;
};

export default function CycleChart({
  series,
  troughDates,
  peakDates,
  signalDates = [],
  signalLabel = "신호",
}: Props) {
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
      // 10년 이상을 한 화면에 놓으면 선형 축에서는 초기 구간이 바닥에 붙어 안 보인다.
      rightPriceScale: { borderColor: "#232b39", mode: PriceScaleMode.Logarithmic },
      timeScale: { borderColor: "#232b39" },
      crosshair: { mode: 1 },
      handleScale: { axisPressedMouseMove: false },
      width: el.clientWidth,
      height: 320,
    });
    chartRef.current = chart;

    const line = chart.addLineSeries({
      color: "#60a5fa",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    line.setData(
      series.map((p) => ({ time: p.date as unknown as UTCTimestamp, value: p.close })),
    );

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
      ...signalDates.map((d) => ({
        time: d as unknown as UTCTimestamp,
        position: "belowBar" as const,
        color: "#fbbf24",
        shape: "circle" as const,
        text: signalLabel,
      })),
    ].sort((a, b) => (String(a.time) < String(b.time) ? -1 : 1));

    line.setMarkers(markers);
    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [series, troughDates, peakDates, signalDates, signalLabel]);

  return <div ref={containerRef} className="rounded-2xl border border-border bg-surface p-1" />;
}
