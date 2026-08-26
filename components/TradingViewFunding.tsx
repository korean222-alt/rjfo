"use client";

import { useEffect, useRef } from "react";

/**
 * 트레이딩뷰 공개 위젯 — API 키 없음.
 * 무기한 선물(BTCUSDT.P) 일봉에 펀딩비 지표를 켠 차트를 그대로 띄운다.
 */
export default function TradingViewFunding({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = "";

    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "calc(100% - 28px)";
    widget.style.width = "100%";
    el.appendChild(widget);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: "D",
      timezone: "Asia/Seoul",
      theme: "dark",
      style: "1",
      locale: "kr",
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: false,
      calendar: false,
      hide_volume: false,
      studies: ["STD;Funding_Rate"],
      support_host: "https://www.tradingview.com",
    });
    el.appendChild(script);

    return () => {
      el.innerHTML = "";
    };
  }, [symbol]);

  return (
    <section className="rounded-2xl border border-border bg-surface p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">펀딩비 · TradingView</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            무기한 선물({symbol.replace("BINANCE:", "")}) 일봉입니다. 키 없이 트레이딩뷰 공개 위젯을 붙였습니다.
          </p>
        </div>
        <a
          href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs font-medium text-muted underline underline-offset-2"
        >
          크게 보기
        </a>
      </div>
      <div className="h-[420px] w-full overflow-hidden rounded-xl">
        <div ref={ref} className="tradingview-widget-container h-full w-full" />
      </div>
    </section>
  );
}
