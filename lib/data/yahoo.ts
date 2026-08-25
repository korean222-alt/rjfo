import type { Bar } from "@/types";
import { DataProviderError, type DataProvider } from "./provider";

/**
 * Yahoo 비공식 chart 엔드포인트 어댑터.
 *
 * 429 대응 (중요):
 *  Yahoo는 클라우드/데이터센터 IP(= Vercel 람다)에서 오는 요청을 자주 429로 막는다.
 *  로컬에선 되는데 배포하면 "HTTP 429"가 뜨는 이유가 이것이다. 그래서
 *   1) query1 / query2 두 호스트를 번갈아 시도하고,
 *   2) 429/401/403이면 쿠키+crumb 세션을 만들어 다시 시도하고,
 *   3) 지수 백오프(지터 포함)로 짧게 재시도하되 전체 시간 예산을 넘기지 않는다.
 *  그래도 막히면 상위(lib/data/index.ts)가 Stooq 폴백으로 넘어간다.
 *
 * 조정(adjustment) 처리:
 *  1) 배당 조정 — adjclose/close 비율을 OHLC 전체에 곱한다. 거래량은 배당과 무관하므로 그대로.
 *  2) 분할 조정 — Yahoo는 보통 이미 분할 조정된 값을 주지만 보장은 없다.
 *     splits 이벤트를 받아 분할 전후 종가 점프를 실측해서, 조정이 안 되어 있을 때만 직접 적용한다.
 *     (분할 조정 없이 거래량을 비교하면 액면분할일에 거래량이 인위적으로 튀어 결과가 전부 오염된다.)
 */

const HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];
const CHART_PATH = "/v8/finance/chart";
const CRUMB_PATH = "/v1/test/getcrumb";
const COOKIE_URL = "https://fc.yahoo.com/";

const DEFAULT_DEADLINE_MS = 6_000;
const PER_ATTEMPT_CAP_MS = 4_000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function baseHeaders(): Record<string, string> {
  return {
    // 브라우저처럼 보이지 않으면 Yahoo가 종종 거절한다.
    "User-Agent": UA,
    Accept: "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://finance.yahoo.com/",
    Origin: "https://finance.yahoo.com",
  };
}

type YahooSplit = { date: number; numerator: number; denominator: number };

type YahooChart = {
  chart: {
    error: { code: string; description: string } | null;
    result:
      | [
          {
            timestamp?: number[];
            indicators: {
              quote: [
                {
                  open?: (number | null)[];
                  high?: (number | null)[];
                  low?: (number | null)[];
                  close?: (number | null)[];
                  volume?: (number | null)[];
                },
              ];
              adjclose?: [{ adjclose?: (number | null)[] }];
            };
            events?: { splits?: Record<string, YahooSplit> };
            meta?: { exchangeTimezoneName?: string };
          },
        ]
      | null;
  };
};

// ── 람다 인스턴스 단위 세션 상태 ────────────────────────────────────
type Session = { cookie: string; crumb: string };
let session: Session | null = null;

/** 테스트용 — 인스턴스 상태 초기화. */
export function __resetYahooSession(): void {
  session = null;
}

function deadlineMs(): number {
  const raw = Number(process.env.DATA_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEADLINE_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readSetCookie(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/** Set-Cookie 헤더들에서 name=value 부분만 모아 Cookie 헤더 문자열로 만든다. */
export function cookieHeaderFrom(setCookies: string[]): string {
  const pairs: string[] = [];
  for (const line of setCookies) {
    // 한 헤더에 여러 쿠키가 합쳐져 오는 구현도 있어서 ", name=" 경계로 한 번 더 쪼갠다.
    for (const part of line.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
      const pair = part.split(";")[0].trim();
      if (pair && pair.includes("=")) pairs.push(pair);
    }
  }
  return pairs.join("; ");
}

async function timedFetch(url: string, headers: Record<string, string>, budgetMs: number) {
  return fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(Math.max(500, Math.min(PER_ATTEMPT_CAP_MS, budgetMs))),
  });
}

/** 쿠키 + crumb 세션 확보. 실패해도 치명적이지 않다(그냥 crumb 없이 간다). */
async function ensureSession(budgetMs: number): Promise<Session | null> {
  if (session) return session;
  try {
    const cookieRes = await timedFetch(COOKIE_URL, baseHeaders(), budgetMs);
    const cookie = cookieHeaderFrom(readSetCookie(cookieRes));
    if (!cookie) return null;

    const crumbRes = await timedFetch(
      `${HOSTS[0]}${CRUMB_PATH}`,
      { ...baseHeaders(), Cookie: cookie },
      budgetMs,
    );
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    // 크럼 대신 HTML 에러 페이지가 오는 경우를 걸러낸다.
    if (!crumb || crumb.length > 32 || crumb.includes("<")) return null;

    session = { cookie, crumb };
    return session;
  } catch {
    return null;
  }
}

type Attempt = { host: string; withSession: boolean };

/** query1 → query2 → (세션 붙여서) query1 → query2 순으로 시도한다. */
const ATTEMPTS: Attempt[] = [
  { host: HOSTS[0], withSession: false },
  { host: HOSTS[1], withSession: false },
  { host: HOSTS[0], withSession: true },
  { host: HOSTS[1], withSession: true },
];

export class YahooProvider implements DataProvider {
  readonly name = "yahoo";

  async getDailyBars(ticker: string, years: number): Promise<Bar[]> {
    const json = await this.fetchChart(ticker, years);

    if (json.chart.error) {
      const code = json.chart.error.code;
      throw new DataProviderError(
        `'${ticker}' 조회 실패: ${json.chart.error.description}`,
        code === "Not Found" ? 404 : 502,
      );
    }

    const result = json.chart.result?.[0];
    if (!result?.timestamp?.length) {
      throw new DataProviderError(`'${ticker}'의 일봉 데이터가 없습니다.`, 404);
    }

    const tz = result.meta?.exchangeTimezoneName || "America/New_York";
    const q = result.indicators.quote[0];
    const adj = result.indicators.adjclose?.[0]?.adjclose;

    const bars: Bar[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      const close = q.close?.[i];
      const volume = q.volume?.[i];
      // 휴장/결측 봉은 버린다.
      if (
        open == null || high == null || low == null ||
        close == null || volume == null || close <= 0
      ) {
        continue;
      }

      // 1) 배당 조정 계수
      const adjClose = adj?.[i];
      const f = adjClose != null && adjClose > 0 ? adjClose / close : 1;

      bars.push({
        date: toExchangeDate(result.timestamp[i], tz),
        open: open * f,
        high: high * f,
        low: low * f,
        close: close * f,
        volume,
      });
    }

    if (!bars.length) {
      throw new DataProviderError(`'${ticker}'의 유효한 일봉이 없습니다.`, 404);
    }

    // 2) 분할 조정 (필요할 때만)
    return applySplitsIfNeeded(bars, Object.values(result.events?.splits ?? {}), tz);
  }

  private async fetchChart(ticker: string, years: number): Promise<YahooChart> {
    const now = Math.floor(Date.now() / 1000);
    const period1 = now - Math.ceil(years * 366 * 24 * 60 * 60);
    const query =
      `?period1=${period1}&period2=${now}&interval=1d` +
      `&events=div%2Csplit&includeAdjustedClose=true`;

    const started = Date.now();
    const budget = deadlineMs();
    const left = () => budget - (Date.now() - started);

    let lastStatus = 0;
    let lastDetail = "";

    for (let i = 0; i < ATTEMPTS.length; i++) {
      if (left() <= 300) break;
      const { host, withSession } = ATTEMPTS[i];

      const headers = baseHeaders();
      let url = `${host}${CHART_PATH}/${encodeURIComponent(ticker)}${query}`;
      if (withSession) {
        const s = await ensureSession(left());
        if (s) {
          headers.Cookie = s.cookie;
          url += `&crumb=${encodeURIComponent(s.crumb)}`;
        }
      }

      let res: Response;
      try {
        res = await timedFetch(url, headers, left());
      } catch (e) {
        lastStatus = 0;
        lastDetail = (e as Error).message;
        await backoff(i, left());
        continue;
      }

      if (res.ok) {
        try {
          return (await res.json()) as YahooChart;
        } catch (e) {
          lastStatus = 502;
          lastDetail = `응답 파싱 실패: ${(e as Error).message}`;
          await backoff(i, left());
          continue;
        }
      }

      // 없는 티커는 재시도해도 소용없다. 즉시 종료.
      if (res.status === 404) {
        throw new DataProviderError(`'${ticker}' 티커를 찾을 수 없습니다.`, 404);
      }

      lastStatus = res.status;
      lastDetail = `HTTP ${res.status}`;
      // 인증/차단 계열이면 다음 시도 전에 세션을 새로 만든다.
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        session = null;
      }
      await backoff(i, left());
    }

    if (lastStatus === 429) {
      throw new DataProviderError(
        "시세 서버가 요청을 제한하고 있습니다 (HTTP 429).",
        429,
      );
    }
    throw new DataProviderError(
      `시세 서버 오류 (${lastDetail || "응답 없음"}).`,
      lastStatus >= 400 && lastStatus < 500 ? lastStatus : 502,
    );
  }
}

/** 250ms, 600ms, 1200ms … + 지터. 남은 예산을 넘지 않는다. */
async function backoff(attemptIndex: number, remainingMs: number): Promise<void> {
  const wait = Math.min(250 * Math.pow(2, attemptIndex), 1200) + Math.random() * 150;
  const capped = Math.min(wait, Math.max(0, remainingMs - 300));
  if (capped > 0) await sleep(capped);
}

/**
 * 거래소 로컬 날짜를 YYYY-MM-DD 문자열로 만든다.
 * new Date()의 로컬 타임존 변환에 의존하지 않기 위해 Intl로 거래소 TZ를 명시한다.
 */
function toExchangeDate(epochSeconds: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(epochSeconds * 1000)); // en-CA → YYYY-MM-DD
}

/**
 * 분할이 이미 반영돼 있으면 그대로, 아니면 분할 이전 구간의 가격을 1/r, 거래량을 r배 한다.
 * 판정: 분할일 직전 종가 / 분할일 종가 ≈ r 이면 미조정 상태.
 */
export function applySplitsIfNeeded(
  bars: Bar[],
  splits: YahooSplit[],
  timeZone: string,
): Bar[] {
  if (!splits.length) return bars;

  const out = bars.map((b) => ({ ...b }));
  const indexByDate = new Map(out.map((b, i) => [b.date, i]));

  for (const s of splits) {
    const ratio = s.numerator / s.denominator; // 4:1 → 4
    if (!isFinite(ratio) || ratio <= 0 || ratio === 1) continue;

    const splitDate = toExchangeDate(s.date, timeZone);
    const idx = indexByDate.get(splitDate);
    if (idx == null || idx === 0) continue;

    const before = out[idx - 1].close;
    const after = out[idx].close;
    if (!(before > 0 && after > 0)) continue;

    const observedJump = before / after;
    // 미조정이면 점프가 ratio에 가깝다. 노이즈를 감안해 중간값(√ratio)을 임계로 쓴다.
    const alreadyAdjusted = observedJump < Math.sqrt(ratio);
    if (alreadyAdjusted) continue;

    for (let i = 0; i < idx; i++) {
      out[i].open /= ratio;
      out[i].high /= ratio;
      out[i].low /= ratio;
      out[i].close /= ratio;
      out[i].volume *= ratio;
    }
  }

  return out;
}
