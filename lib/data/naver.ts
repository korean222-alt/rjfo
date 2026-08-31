import type { Bar } from "@/types";
import { DataProviderError, type DataProvider } from "./provider";

/**
 * 한국 종목(KRX) 전용 시세 소스 — 네이버 금융 차트 API.
 *
 * 왜 따로 두는가:
 *  한국 종목은 갈 데가 없다. Twelve Data 무료 플랜에 KRX가 없고, Stooq는 한국 주식을
 *  아예 안 준다(CSV 대신 안내 페이지가 온다). 남는 건 Yahoo 하나인데, Yahoo는 데이터센터
 *  IP를 429로 막는다. 그래서 "삼성전자"를 넣으면 429 + 'CSV 대신 페이지' 두 줄짜리
 *  에러만 남았다. 네이버는 API 키가 없고 요청 제한도 훨씬 느슨해서, KRX에서는 이쪽을
 *  1순위로 두는 게 맞다.
 *
 * 응답 형식 (JSON이 아니라 작은따옴표 배열 리터럴이다):
 *   [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
 *    ['20240102', 79600, 79800, 78200, 79600, 17142848, 54.10],
 *    ...]
 *
 * 값은 수정주가(액면분할 반영)다. 배당 조정은 하지 않는다 — Stooq와 같은 수준이고,
 * 거래량·추세 판정이 목적이므로 문제되지 않는다.
 */

const BASE = "https://api.finance.naver.com/siseJson.naver";
const TIMEOUT_MS = 8_000;

/** 005930.KS / 000660.KQ → 005930. 코스피·코스닥 구분은 네이버가 알아서 한다. */
export function toNaverSymbol(ticker: string): string | null {
  const m = /^(\d{6})(?:\.(KS|KQ))?$/i.exec(ticker.trim());
  return m ? m[1] : null;
}

export function isKoreanTicker(ticker: string): boolean {
  return toNaverSymbol(ticker) !== null;
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 응답 텍스트 → Bar[].
 *
 * JSON.parse에 기대지 않는다. 작은따옴표를 큰따옴표로 바꾸는 식의 전처리는 값 안에
 * 따옴표나 예상 못한 공백이 하나만 섞여도 통째로 실패한다. 대괄호 한 쌍씩 긁어서
 * '첫 칸이 8자리 날짜인 행'만 받아들이면 헤더·주석·개행이 어떻게 오든 상관없다.
 */
export function parseNaverSise(text: string): Bar[] {
  const bars: Bar[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(/\[([^[\]]*)\]/g)) {
    const fields = m[1].split(",").map((f) => f.trim().replace(/^['"]|['"]$/g, ""));
    if (fields.length < 6) continue;

    const raw = fields[0];
    if (!/^\d{8}$/.test(raw)) continue; // 헤더 행('날짜', ...)은 여기서 걸러진다
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    if (seen.has(date)) continue;

    const [open, high, low, close, volume] = fields.slice(1, 6).map(Number);
    if (![open, high, low, close, volume].every((n) => Number.isFinite(n))) continue;
    if (close <= 0 || volume < 0) continue;

    seen.add(date);
    bars.push({ date, open, high, low, close, volume });
  }

  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return bars;
}

export class NaverProvider implements DataProvider {
  readonly name = "naver";

  async getDailyBars(ticker: string, years: number): Promise<Bar[]> {
    const symbol = toNaverSymbol(ticker);
    if (!symbol) {
      throw new DataProviderError(
        `'${ticker}'는 한국 종목 코드가 아닙니다 (네이버 소스는 6자리 코드만 받습니다).`,
        404,
      );
    }

    const end = new Date();
    const start = new Date(end.getTime() - Math.ceil(years * 366) * 86400000);
    const url =
      `${BASE}?symbol=${symbol}&requestType=1` +
      `&startTime=${yyyymmdd(start)}&endTime=${yyyymmdd(end)}&timeframe=day`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          // 레퍼러가 없으면 네이버가 거절할 때가 있다.
          Referer: "https://finance.naver.com/",
          Accept: "*/*",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new DataProviderError(
        `네이버 금융에 연결하지 못했습니다: ${(e as Error).message}`,
        504,
      );
    }

    if (!res.ok) {
      throw new DataProviderError(
        `네이버 금융이 HTTP ${res.status}로 응답했습니다.`,
        res.status === 429 ? 429 : 502,
      );
    }

    const text = await res.text();
    const bars = parseNaverSise(text);
    if (bars.length) return bars;

    // 시세 행이 없는 이유가 두 가지다. 이걸 구분해야 한다:
    //  ① 없는 종목 코드 — 배열은 오는데 헤더 행만 있다 → 404 (다음 소스도 없을 것이다)
    //  ② 차단·점검 — 배열이 아니라 HTML 페이지가 온다 → 502 (다음 소스로 가야 한다)
    // 둘을 다 404로 쓰면 상위 체인이 "그런 티커 없다"로 믿어 폴백이 멈추고,
    // 화면에는 진짜 원인(차단)이 아니라 "티커 없음"이 뜬다.
    const looksLikeSise = /\[\s*['"]?날짜/.test(text) || text.trimStart().startsWith("[");
    throw new DataProviderError(
      looksLikeSise
        ? `'${ticker}' 일봉이 네이버에 없습니다 (없는 종목 코드일 수 있습니다).`
        : `'${ticker}' 네이버가 시세 대신 다른 응답을 보냈습니다: ${text.replace(/\s+/g, " ").trim().slice(0, 80)}`,
      looksLikeSise ? 404 : 502,
    );
  }
}
