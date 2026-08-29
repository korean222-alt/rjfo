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

/** 코인 무기한 선물 (펀딩비 지표를 붙일 수 있는 심볼). */
const CRYPTO_PERP: Record<string, string> = {
  "BTC-USD": "BINANCE:BTCUSDT.P",
  "ETH-USD": "BINANCE:ETHUSDT.P",
  "SOL-USD": "BINANCE:SOLUSDT.P",
  "XRP-USD": "BINANCE:XRPUSDT.P",
  "DOGE-USD": "BINANCE:DOGEUSDT.P",
  "ADA-USD": "BINANCE:ADAUSDT.P",
};

export function toTradingViewSymbol(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  if (!t) return CRYPTO_SPOT["BTC-USD"];

  const spot = CRYPTO_SPOT[t];
  if (spot) return spot;

  // 코인이지만 위 목록에 없는 것 (XXX-USD) → 같은 규칙으로 만든다.
  const crypto = t.match(/^([A-Z0-9]+)-USD$/);
  if (crypto) return `CRYPTO:${crypto[1]}USD`;

  // 한국 종목: 코스피·코스닥 모두 TradingView에서는 KRX 아래에 있다.
  const kr = t.match(/^(\d{6})\.(KS|KQ)$/);
  if (kr) return `KRX:${kr[1]}`;

  // 미국 주식 등은 거래소 없이 넘기면 TradingView가 알아서 찾는다.
  return t;
}

export function toTradingViewPerpSymbol(ticker: string): string | null {
  return CRYPTO_PERP[ticker.trim().toUpperCase()] ?? null;
}

/** 위젯 헤더/링크에 쓰는 짧은 이름 (CRYPTO:BTCUSD → BTCUSD). */
export function shortSymbol(symbol: string): string {
  const i = symbol.indexOf(":");
  return i === -1 ? symbol : symbol.slice(i + 1);
}
