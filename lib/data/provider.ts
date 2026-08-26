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
};

export function normalizeTicker(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const alias = TICKER_ALIASES[trimmed] ?? TICKER_ALIASES[trimmed.toUpperCase()];
  if (alias) return alias;
  return trimmed.toUpperCase();
}

export function isValidTicker(ticker: string): boolean {
  return /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/.test(ticker);
}

export function isCryptoTicker(ticker: string): boolean {
  return /^(BTC|ETH|SOL|XRP|DOGE|ADA)-USD$/.test(ticker);
}
