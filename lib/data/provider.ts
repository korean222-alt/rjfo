import type { Bar } from "@/types";

/**
 * 데이터 소스 어댑터 인터페이스.
 * 구현체를 갈아끼우면(Yahoo → Polygon/Tiingo 등) 나머지 코드는 그대로 둔다.
 */
export interface DataProvider {
  readonly name: string;
  /** 분할·배당 조정된 일봉을 오래된 순으로 반환한다. */
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

export function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase();
}

/** 티커 유효성: 영문/숫자와 . - ^ = 만 허용 (BRK.B, ^GSPC, 005930.KS 등). */
export function isValidTicker(ticker: string): boolean {
  return /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/.test(ticker);
}
