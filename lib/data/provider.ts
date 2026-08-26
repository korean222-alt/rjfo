import type { Bar } from "@/types";

export interface DataProvider {
  readonly name: string;
  getDailyBars(ticker: string, years: number): Promise<Bar[]>;
}

export class DataProviderError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
  ) {
    super(message);
    this.name = "DataProviderError";
  }
}

const TICKER_ALIASES: Record<string, string> = {
  BTC: "BTC-USD",
  BITCOIN: "BTC-USD",
  BTCUSD: "BTC-USD",
  "BTC/USD": "BTC-USD",
  XBT: "BTC-USD",
  XBTUSD: "BTC-USD",
  "비트코인": "BTC-USD",
  "비트": "BTC-USD",
  ETH: "ETH-USD",
  ETHEREUM: "ETH-USD",
  ETHUSD: "ETH-USD",
  "ETH/USD": "ETH-USD",
  "이더리움": "ETH-USD",
  "이더": "ETH-USD",
  SOL: "SOL-USD",
  SOLANA: "SOL-USD",
  SOLUSD: "SOL-USD",
  "SOL/USD": "SOL-USD",
  "솔라나": "SOL-USD",
  XRP: "XRP-USD",
  RIPPLE: "XRP-USD",
  XRPUSD: "XRP-USD",
  "리플": "XRP-USD",
  DOGE: "DOGE-USD",
  DOGECOIN: "DOGE-USD",
  DOGEUSD: "DOGE-USD",
  "도지": "DOGE-USD",
  ADA: "ADA-USD",
  CARDANO: "ADA-USD",
  ADAUSD: "ADA-USD",
  "에이다": "ADA-USD",
  "카르다노": "ADA-USD",
  "삼성전자": "005930.KS",
  "삼성": "005930.KS",
  "SK하이닉스": "000660.KS",
  "하이닉스": "000660.KS",
  "카카오": "035720.KS",
  "네이버": "035420.KS",
  "현대차": "005380.KS",
  "기아": "000270.KS",
};

export function normalizeTicker(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const alias = TICKER_ALIASES[trimmed] ?? TICKER_ALIASES[trimmed.toUpperCase()];
  if (alias) return alias;
  const upper = trimmed.toUpperCase();
  // 한국 종목 6자리는 Yahoo/Stooq가 거래소 접미사를 요구한다 (005930 → 005930.KS).
  if (/^\d{6}$/.test(upper)) return `${upper}.KS`;
  return upper;
}

export function isValidTicker(ticker: string): boolean {
  return /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/.test(ticker);
}

export function isCryptoTicker(ticker: string): boolean {
  return /^(BTC|ETH|SOL|XRP|DOGE|ADA)-USD$/.test(ticker);
}
