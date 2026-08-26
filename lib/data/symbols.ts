/** Yahoo 스타일 티커를 Twelve Data 심볼로. 암호는 BTC/USD 형태를 쓴다. */
export function toTwelveSymbol(ticker: string): string {
  if (/^[A-Z0-9]+-USD$/.test(ticker)) return ticker.replace("-USD", "/USD");
  return ticker;
}

/**
 * StooqProvider.toStooqSymbol 이 이해할 수 있는 형태로 바꾼다.
 * 접미사 .V 는 거래소로 인정되어 btcusd.v 가 된다 (Stooq 비트코인 심볼).
 */
export function toStooqCryptoSymbol(ticker: string): string | null {
  if (ticker === "BTC-USD") return "BTCUSD.V";
  if (ticker === "ETH-USD") return "ETHUSD.V";
  if (ticker === "SOL-USD") return "SOLUSD.V";
  if (ticker === "XRP-USD") return "XRPUSD.V";
  if (ticker === "DOGE-USD") return "DOGEUSD.V";
  if (ticker === "ADA-USD") return "ADAUSD.V";
  return null;
}
