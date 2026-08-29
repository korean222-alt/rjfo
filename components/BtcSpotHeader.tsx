"use client";

import { spotMeta } from "@/lib/tradingview";

type Props = {
  ticker: string;
};

/** TradingView 심볼 검색에 나오는 그 한 줄: BTCUSD · Bitcoin · CRYPTO · spot crypto */
export default function BtcSpotHeader({ ticker }: Props) {
  const meta = spotMeta(ticker);
  if (!meta) return null;
  const isBtc = ticker === "BTC-USD";

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-[#131722] px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {isBtc ? <BtcMark /> : <CryptoMark />}
        <div className="min-w-0">
          <p className="text-[17px] font-bold leading-tight tracking-tight text-white">{meta.symbol}</p>
          <p className="text-[12px] leading-tight text-[#868993]">{meta.name}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="text-right leading-tight">
          <p className="text-[13px] font-semibold text-[#9b87f5]">CRYPTO</p>
          <p className="text-[11px] text-[#868993]">spot crypto</p>
        </div>
        <span
          title={`${meta.tv} 현물 지수입니다. 바이낸스 무기한 선물(USDT.P)이 아닙니다.`}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#4a5568] text-[11px] font-semibold text-[#868993]"
        >
          i
        </span>
      </div>
    </div>
  );
}

function BtcMark() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#F7931A" />
      <path
        fill="#fff"
        d="M18.2 16.7c1.4-.4 2.3-1.3 2.1-2.8-.3-1.6-1.6-2.1-3.4-2.3V9.3h-1.7v2.2h-1.4V9.3h-1.7v2.3H9.6v1.8h1.1c.4 0 .6.2.6.6v7.2c0 .3-.2.5-.5.5H9.6V24h2.5v2.3h1.7V24h1.4v2.3h1.7v-2.3c2.3-.2 3.9-1.1 4.2-3.1.2-1.5-.5-2.4-1.9-2.9zm-4.8-3.6h1.9c1.1 0 2.4.1 2.4 1.4s-1.2 1.5-2.5 1.5h-1.8v-2.9zm2.2 7.7h-2.2v-3.1h2.3c1.4 0 2.7.2 2.7 1.6-.1 1.4-1.4 1.5-2.8 1.5z"
      />
    </svg>
  );
}

function CryptoMark() {
  return (
    <span
      aria-hidden
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#9b87f5] text-[11px] font-black text-white"
    >
      $
    </span>
  );
}
