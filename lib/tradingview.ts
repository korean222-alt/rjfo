/**
 * 우리 티커 → TradingView 심볼.
 *
 * 비트코인은 CRYPTO:BTCUSD 를 쓴다. TradingView 심볼 검색에서
 * "BTCUSD · Bitcoin · CRYPTO · spot crypto" 로 나오는 그 심볼이다.
 * 거래소 하나(BINANCE:BTCUSDT 등)가 아니라 여러 현물 거래소를 합친 지수라
 * 특정 거래소가 튀어도 차트가 흔들리지 않는다. 무기한 선물(.P)도 아니다.
 */

const CRYPTO_SPOT: Record<string, string> = {
  "BTC-USD": "CRYPTO:BTCUSD",
  "ETH-USD": "CRYPTO:ETHUSD",
  "SOL-USD": "CRYPTO:SOLUSD",
  "XRP-USD": "CRYPTO:XRPUSD",
  "DOGE-USD": "CRYPTO:DOGEUSD",
  "ADA-USD": "CRYPTO:ADAUSD",
};

export type SpotMeta = {
  symbol: string;
  name: string;
  tv: string;
};

const SPOT_META: Record<string, SpotMeta> = {
  "BTC-USD": { symbol: "BTCUSD", name: "Bitcoin", tv: "CRYPTO:BTCUSD" },
  "ETH-USD": { symbol: "ETHUSD", name: "Ethereum", tv: "CRYPTO:ETHUSD" },
  "SOL-USD": { symbol: "SOLUSD", name: "Solana", tv: "CRYPTO:SOLUSD" },
  "XRP-USD": { symbol: "XRPUSD", name: "XRP", tv: "CRYPTO:XRPUSD" },
  "DOGE-USD": { symbol: "DOGEUSD", name: "Dogecoin", tv: "CRYPTO:DOGEUSD" },
  "ADA-USD": { symbol: "ADAUSD", name: "Cardano", tv: "CRYPTO:ADAUSD" },
};

export function spotMeta(ticker: string): SpotMeta | null {
  return SPOT_META[ticker.trim().toUpperCase()] ?? null;
}

export function toTradingViewSymbol(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  if (!t) return CRYPTO_SPOT["BTC-USD"];

  const spot = CRYPTO_SPOT[t];
  if (spot) return spot;

  const crypto = t.match(/^([A-Z0-9]+)-USD$/);
  if (crypto) return `CRYPTO:${crypto[1]}USD`;

  const kr = t.match(/^(\d{6})\.(KS|KQ)$/);
  if (kr) return `KRX:${kr[1]}`;

  return t;
}

/** 위젯 헤더/링크에 쓰는 짧은 이름 (CRYPTO:BTCUSD → BTCUSD). */
export function shortSymbol(symbol: string): string {
  const i = symbol.indexOf(":");
  return i === -1 ? symbol : symbol.slice(i + 1);
}
