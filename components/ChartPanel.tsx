"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import VolumeChart, { type ChartMarker, type SeriesPoint } from "@/components/VolumeChart";
import {
  TIMEFRAMES,
  TIMEFRAME_INTERVAL,
  TIMEFRAME_LABEL,
  TIMEFRAME_UNIT,
  aggregateBars,
  bucketStart,
  type Timeframe,
} from "@/lib/timeframe";
import { toTradingViewSymbol } from "@/lib/tradingview";
import type { Bar } from "@/types";

const TradingViewChart = dynamic(() => import("@/components/TradingViewChart"), {
  ssr: false,
  loading: () => <div className="h-[460px] rounded-2xl border border-border bg-surface" />,
});

/**
 * 결과 화면의 차트 묶음.
 *
 *  - 위: TradingView 차트. 비트코인이면 CRYPTO:BTCUSD(현물 지수)로 뜬다.
 *  - 아래: 우리 데이터로 그린 캔들·거래량 차트 (조건에 걸린 날 화살표).
 *
 * 일봉/주봉/월봉 버튼은 두 차트에 동시에 걸린다. 주봉·월봉은 받아온 일봉을
 * 묶어서 만든다 (시세 소스가 일봉만 주기 때문).
 */
type Props = {
  ticker: string;
  series: SeriesPoint[];
  matchDates: string[];
  maPeriods?: number[];
  extraMarkers?: ChartMarker[];
};

export default function ChartPanel({
  ticker,
  series,
  matchDates,
  maPeriods = [],
  extraMarkers = [],
}: Props) {
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");

  const view = useMemo(() => {
    if (timeframe === "1d") return series;
    const bars: Bar[] = series.map((p) => ({
      date: p.date,
      open: p.open ?? p.close,
      high: p.high ?? p.close,
      low: p.low ?? p.close,
      close: p.close,
      volume: p.volume,
      funding: p.funding ?? null,
    }));
    return aggregateBars(bars, timeframe).map((b) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      funding: b.funding ?? null,
    }));
  }, [series, timeframe]);

  // 매칭일은 일봉 날짜다. 주봉·월봉에서는 그 날이 속한 봉에 화살표를 찍는다.
  const viewMatchDates = useMemo(
    () => (timeframe === "1d" ? matchDates : matchDates.map((d) => bucketStart(d, timeframe))),
    [matchDates, timeframe],
  );
  const viewMarkers = useMemo(
    () =>
      timeframe === "1d"
        ? extraMarkers
        : extraMarkers.map((m) => ({ ...m, date: bucketStart(m.date, timeframe) })),
    [extraMarkers, timeframe],
  );

  const symbol = useMemo(() => toTradingViewSymbol(ticker), [ticker]);

  return (
    <div className="space-y-4">
      <div
        className="flex gap-1 rounded-xl border border-border bg-surface p-1"
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

      <TradingViewChart
        symbol={symbol}
        interval={TIMEFRAME_INTERVAL[timeframe]}
        caption={`${TIMEFRAME_LABEL[timeframe]}. 티커는 위에서 분석한 종목을 따라갑니다.`}
      />

      <VolumeChart
        series={view}
        matchDates={viewMatchDates}
        maPeriods={maPeriods}
        maUnit={TIMEFRAME_UNIT[timeframe]}
        extraMarkers={viewMarkers}
      />

      {timeframe === "1d" ? null : (
        <p className="rounded-xl border border-border bg-surface px-4 py-2.5 text-xs leading-relaxed text-muted">
          분석·통계는 일봉 기준입니다. {TIMEFRAME_LABEL[timeframe]}은 같은 일봉을 묶어서 보여 주는
          것이고, 화살표는 그 날이 속한 봉에 찍힙니다.
        </p>
      )}
    </div>
  );
}
