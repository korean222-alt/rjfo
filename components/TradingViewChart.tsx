"use client";

import { useEffect, useRef } from "react";
import { shortSymbol } from "@/lib/tradingview";

/**
 * TradingView 공개 위젯 (API 키 없음).
 *
 * 심볼과 봉(interval)은 이 앱의 입력이 정한다. 위젯 안에서 심볼을 바꾸면 아래 지표
 * 패널과 어긋나므로 allow_symbol_change는 끈다.
 *
 * 위젯은 스크립트를 붙이는 순간의 설정만 읽는다. 그래서 심볼/봉이 바뀌면
 * 컨테이너를 비우고 스크립트를 다시 만든다.
 */

export type TvStudy = { id: string; inputs?: Record<string, number | string> };

type Props = {
  symbol: string;
  /** "D" | "W" | "M" */
  interval: string;
  studies?: TvStudy[];
  height?: number;
  /** 헤더에 붙는 한 줄 설명 */
  caption?: string;
};

export default function TradingViewChart({
  symbol,
  interval,
  studies = [],
  height = 460,
  caption,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = "";

    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widget.style.width = "100%";
    el.appendChild(widget);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval,
      timezone: "Asia/Seoul",
      theme: "dark",
      style: "1",
      locale: "kr",
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: false,
      calendar: false,
      hide_volume: false,
      studies,
      support_host: "https://www.tradingview.com",
    });
    el.appendChild(script);

    return () => {
      el.innerHTML = "";
    };
    // studies는 배열이라 매 렌더 새 참조가 된다. 내용이 같으면 다시 그리지 않도록 키로 비교한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, JSON.stringify(studies)]);

  return (
    <section className="rounded-2xl border border-border bg-surface p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{shortSymbol(symbol)} · TradingView</h2>
          {caption ? <p className="mt-1 text-xs leading-relaxed text-muted">{caption}</p> : null}
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
      {/*
        위젯이 못 뜨는 경우(회사망·확장 프로그램의 트래커 차단 등)에도 빈 상자만 남지 않도록
        안내를 깔아 두고, 위젯이 뜨면 그 위를 덮는다.
      */}
      <div className="relative w-full overflow-hidden rounded-xl bg-bg" style={{ height }}>
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs leading-relaxed text-muted">
          차트를 불러오는 중입니다. 계속 비어 있으면 광고·트래커 차단이 tradingview.com을 막고
          있는 것이니, 위의 &lsquo;크게 보기&rsquo;로 열어 보세요.
        </p>
        <div ref={ref} className="tradingview-widget-container absolute inset-0 h-full w-full" />
      </div>
    </section>
  );
}
