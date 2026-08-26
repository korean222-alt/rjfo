import type { Bar } from "@/types";
import { DataProviderError, type DataProvider } from "./provider";

/**
 * Twelve Data 어댑터 — API 키 기반 소스.
 *
 * 왜 필요한가:
 *  Yahoo도 Stooq도 "키 없이 쓰는 비공식/무료" 소스라, 서버 IP(Vercel 람다)를
 *  IP만 보고 막아 버린다. 실제로 배포 환경에서 Yahoo는 429, Stooq는 CSV 대신
 *  봇 차단 페이지를 돌려줬다. 키 기반 소스는 IP가 아니라 키로 식별하므로
 *  데이터센터에서 불러도 막히지 않는다.
 *
 *  무료 플랜으로 충분하다 (하루 800 요청). 12시간 캐시가 앞단에 있으니
 *  티커 하나당 하루 두 번이면 된다.
 *
 * 키가 없으면 이 소스는 체인에서 아예 빠진다 (lib/data/index.ts).
 */

const BASE = "https://api.twelvedata.com/time_series";
const TIMEOUT_MS = 8_000;

type TwelveValue = {
  datetime?: string;
  open?: string | number;
  high?: string | number;
  low?: string | number;
  close?: string | number;
  volume?: string | number;
};

type TwelveResponse = {
  status?: string;
  code?: number;
  message?: string;
  values?: TwelveValue[];
};

export function twelveDataKey(): string | null {
  const key = process.env.TWELVE_DATA_API_KEY?.trim();
  return key ? key : null;
}

/** 응답의 values 배열 → Bar[] (오래된 순, 결측·이상치 제거). */
export function parseTwelveValues(values: TwelveValue[]): Bar[] {
  const bars: Bar[] = [];
  const seen = new Set<string>();

  for (const v of values) {
    const date = typeof v.datetime === "string" ? v.datetime.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;

    const open = Number(v.open);
    const high = Number(v.high);
    const low = Number(v.low);
    const close = Number(v.close);
    // 지수 등 거래량이 없는 심볼은 0으로 온다. 그대로 두면 거래량 필터가 무의미해진다.
    const volume = Number(v.volume ?? 0);

    if (![open, high, low, close, volume].every((n) => Number.isFinite(n))) continue;
    if (close <= 0 || volume < 0) continue;

    seen.add(date);
    bars.push({ date, open, high, low, close, volume });
  }

  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return bars;
}

export class TwelveDataProvider implements DataProvider {
  readonly name = "twelvedata";

  async getDailyBars(ticker: string, years: number): Promise<Bar[]> {
    const key = twelveDataKey();
    if (!key) {
      throw new DataProviderError("TWELVE_DATA_API_KEY가 설정되지 않았습니다.", 500);
    }

    const outputsize = Math.min(5000, Math.ceil(years * 253) + 60);
    const url =
      `${BASE}?symbol=${encodeURIComponent(ticker)}` +
      `&interval=1day&outputsize=${outputsize}&order=ASC&apikey=${encodeURIComponent(key)}`;

    let res: Response | null = null;
    let json: TwelveResponse | null = null;
    let lastStatus = 0;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        lastStatus = res.status;
      } catch (e) {
        if (attempt === 0) continue;
        throw new DataProviderError(
          `시세 서버에 연결하지 못했습니다: ${(e as Error).message}`,
          502,
        );
      }

      if (!res) continue;

      try {
        json = (await res.json()) as TwelveResponse;
        break;
      } catch {
        if (attempt === 0) continue;
        throw new DataProviderError(
          `시세 서버 응답을 읽지 못했습니다 (HTTP ${lastStatus}).`,
          lastStatus === 429 ? 429 : 502,
        );
      }
    }

    if (!json) {
      throw new DataProviderError(
        `시세 서버 응답을 읽지 못했습니다 (HTTP ${lastStatus}).`,
        lastStatus === 429 ? 429 : 502,
      );
    }

    // Twelve Data는 오류도 HTTP 200에 담아 보낼 때가 있다. 본문의 status를 먼저 본다.
    if (json.status === "error" || (lastStatus !== 0 && lastStatus >= 400 && !json.values)) {
      const code = json.code ?? lastStatus;
      const message = json.message ?? `HTTP ${lastStatus}`;
      // 무료 플랜에서 막힌 심볼·거래소는 "키가 틀렸다"가 아니다. 키를 넣었는데도 계속
      // 실패한다면 대개 이쪽이므로, 무엇을 해야 하는지 알 수 있게 따로 구분한다.
      if (/plan|upgrade|exclusively|subscription/i.test(message)) {
        throw new DataProviderError(
          `'${ticker}'은(는) 현재 Twelve Data 플랜에서 제공되지 않습니다: ${message}`,
          502,
        );
      }
      if (code === 429 || /api credits|rate limit/i.test(message)) {
        throw new DataProviderError(`시세 API 호출 한도를 초과했습니다: ${message}`, 429);
      }
      if (code === 404 || /not found|symbol/i.test(message)) {
        throw new DataProviderError(`'${ticker}' 티커를 찾을 수 없습니다.`, 404);
      }
      if (code === 401 || code === 403) {
        throw new DataProviderError(`시세 API 키가 거부되었습니다: ${message}`, 502);
      }
      throw new DataProviderError(`시세 API 오류 (${code}): ${message}`, 502);
    }

    const bars = parseTwelveValues(json.values ?? []);
    if (!bars.length) {
      throw new DataProviderError(`'${ticker}'의 일봉 데이터가 없습니다.`, 404);
    }
    return bars;
  }
}
