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
import type { MaCross } from "@/lib/ma-cross";

export type SeriesPoint = {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume: number;
};

export type MaOverlay = {
  fastPeriod: number;
  slowPeriod: number;
  fast: { date: string; value: number }[];
  slow: { date: string; value: number }[];
  crosses: MaCross[];
};

type Props = {
  series: SeriesPoint[];
  matchDates: string[];
  /** 이동평균선 오버레이. 없으면 캔들·거래량만 그린다. */
  ma?: MaOverlay | null;
};

export default function VolumeChart({ series, matchDates, ma }: Props) {
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

    // 이전 버전에서 저장된 결과에는 OHLC가 없을 수 있다. 그 경우 종가를 사용해
    // 평면 캔들로 안전하게 표시하고, 다음 분석부터는 실제 OHLC 캔들이 저장된다.
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

    // 이동평균선 두 개 — 사용자가 정한 기간으로 그린다.
    if (ma && ma.fast.length && ma.slow.length) {
      const fastLine = chart.addLineSeries({
        color: "#f59e0b",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      fastLine.setData(
        ma.fast.map((p) => ({ time: p.date as unknown as UTCTimestamp, value: p.value })),
      );

      const slowLine = chart.addLineSeries({
        color: "#a78bfa",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      slowLine.setData(
        ma.slow.map((p) => ({ time: p.date as unknown as UTCTimestamp, value: p.value })),
      );
    }

    // 마커 두 종류를 한 배열로 합친다 (lightweight-charts는 시리즈당 한 번만 받는다).
    // 신호는 캔들 아래, 교차는 캔들 위 — 같은 날 겹쳐도 서로 가리지 않는다.
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

    if (ma) {
      for (const c of ma.crosses) {
        markers.push({
          time: c.date as unknown as UTCTimestamp,
          position: "aboveBar" as const,
          color: c.type === "golden" ? "#22c55e" : "#ef4444",
          shape: c.type === "golden" ? ("arrowUp" as const) : ("arrowDown" as const),
          text: c.type === "golden" ? "GC" : "DC",
        });
      }
    }

    // 마커는 시간순이어야 한다 (신호와 교차를 합치면서 순서가 섞였다).
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
  }, [series, matchDates, ma]);

  return (
    <section className="rounded-2xl border border-border bg-surface p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">캔들 차트 · 거래량</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            파란 화살표는 현재 조건에 매칭된 신호 날짜입니다.
            {ma ? (
              <>
                {" "}
                위쪽 <span className="text-up">▲GC</span>는 골든크로스,{" "}
                <span className="text-down">▼DC</span>는 데드크로스 —{" "}
                <span className="text-amber-400">{ma.fastPeriod}일선</span>과{" "}
                <span className="text-violet-400">{ma.slowPeriod}일선</span>이 교차한 날입니다.
              </>
            ) : null}
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
