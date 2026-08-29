import type { Bar } from "@/types";
import { getCachedBars, setCachedBars } from "./cache";
import { CryptoExchangeProvider, hasUsableVolume } from "./crypto";
import { FixtureProvider } from "./fixture";
import { DataProviderError, isCryptoTicker, type DataProvider } from "./provider";
import { StooqProvider } from "./stooq";
import { toStooqCryptoSymbol, toTwelveSymbol, tickerFallbacks } from "./symbols";
import { TwelveDataProvider, twelveDataKey } from "./twelvedata";
import { YahooProvider } from "./yahoo";

/** 거래량 분석 기본 기간. 짧게 유지해야 시세 소스가 덜 막힌다. */
export const DEFAULT_YEARS = 5;

/** 사이클 분석용 최대 기간. 상승장 전환은 5년에 한두 번뿐이라 길게 받아야 한다. */
export const MAX_YEARS = 20;

class MappedProvider implements DataProvider {
  constructor(
    private readonly inner: DataProvider,
    private readonly mapTicker: (ticker: string) => string,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  getDailyBars(ticker: string, years: number): Promise<Bar[]> {
    return this.inner.getDailyBars(this.mapTicker(ticker), years);
  }
}

export function getProviders(ticker?: string): DataProvider[] {
  const twelve = new MappedProvider(new TwelveDataProvider(), toTwelveSymbol);
  const yahoo = new YahooProvider();
  const stooq = new MappedProvider(
    new StooqProvider(),
    (t) => toStooqCryptoSymbol(t) ?? t,
  );

  let chain: DataProvider[];
  switch (process.env.DATA_PROVIDER) {
    case "fixture":
      return [new FixtureProvider()];
    case "stooq":
      chain = [stooq];
      break;
    case "yahoo":
      chain = [yahoo];
      break;
    case "twelvedata":
      chain = [twelve];
      break;
    case "crypto":
      chain = [new CryptoExchangeProvider()];
      break;
    default:
      chain = twelveDataKey() ? [twelve, yahoo, stooq] : [yahoo, stooq];
  }

  // 코인은 Twelve Data volume이 0이라 거래량 분석이 불가능하다.
  // 거래소 공개 시세(키 없음)를 맨 앞에 둔다.
  if (ticker && isCryptoTicker(ticker) && process.env.DATA_PROVIDER !== "crypto") {
    return [new CryptoExchangeProvider(), ...chain];
  }
  // 한국 종목은 Twelve Data 무료 플랜에 없다. 키를 써가며 404/플랜 에러를
  // 맞으면 '티커 없음'으로 오인되어 브라우저 폴백 안내가 꼬인다.
  if (ticker && /^\d{6}\.(KS|KQ)$/.test(ticker) && process.env.DATA_PROVIDER !== "twelvedata") {
    return chain.filter((p) => p.name !== "twelvedata");
  }
  return chain;
}

export function getProvider(): DataProvider {
  return getProviders()[0];
}

type Attempt = { source: string; status: number; message: string };

/** 소스별 실패 사유를 한 줄로. 어느 소스가 왜 죽었는지 이게 없으면 알 수 없다. */
function describe(attempts: Attempt[]): string {
  return attempts.map((a) => `${a.source}: ${a.message}`).join(" | ");
}

/**
 * "그런 티커 없다"(404)는 아무 소스나 판정할 수 있는 게 아니다.
 *
 * Stooq는 차단당했을 때도 CSV 대신 안내 문구를 돌려주고, 우리는 그걸 404로 분류한다.
 * 그 404를 그대로 믿고 최우선으로 던지면, 정작 진짜 원인(1순위 소스가 왜 실패했는지)이
 * 지워지고 화면에는 "보조 소스" 얘기만 남는다. 키를 넣었는데도 Stooq 에러만 보이던 이유다.
 *
 * 그래서 1순위 소스가 404라고 했을 때, 또는 모든 소스가 404로 일치할 때만 티커 문제로 본다.
 */
function tickerNotFound(attempts: Attempt[]): Attempt | null {
  if (!attempts.length) return null;
  if (attempts[0].status === 404) return attempts[0];
  if (attempts.every((a) => a.status === 404)) return attempts[0];
  return null;
}

async function fetchFromChain(
  ticker: string,
  years: number,
  tried: Set<string> = new Set(),
): Promise<Bar[]> {
  tried.add(ticker);
  const providers = getProviders(ticker);
  const attempts: Attempt[] = [];

  for (const provider of providers) {
    try {
      const bars = await provider.getDailyBars(ticker, years);
      if (isCryptoTicker(ticker) && !hasUsableVolume(bars)) {
        throw new DataProviderError(
          `'${ticker}' 거래량이 비어 있습니다 (${provider.name}).`,
          422,
        );
      }
      return bars;
    } catch (e) {
      attempts.push({
        source: provider.name,
        status: e instanceof DataProviderError ? e.status : 502,
        message: (e as Error)?.message ?? "알 수 없는 오류",
      });
      // 소스 하나가 막힌 것뿐이면 다음 소스로 계속 간다.
    }
  }

  const sibling = tickerFallbacks(ticker).find((t) => !tried.has(t));
  const notFoundEarly = tickerNotFound(attempts);
  if (notFoundEarly && sibling) {
    try {
      return await fetchFromChain(sibling, years, tried);
    } catch (e) {
      if (!(e instanceof DataProviderError && e.status === 404)) throw e;
    }
  }

  const detail = describe(attempts);

  const notFound = tickerNotFound(attempts);
  if (notFound) throw new DataProviderError(notFound.message, 404);

  // 키 없는 소스만 있는데 전부 막혔다면, 원인은 이 티커가 아니라 서버 IP 차단이다.
  // 사용자가 할 수 있는 조치를 알려준다.
  if (!twelveDataKey()) {
    throw new DataProviderError(
      `무료 시세 소스가 모두 막혔습니다 (${detail}) ` +
        "twelvedata.com에서 무료 API 키를 발급받아 환경변수 TWELVE_DATA_API_KEY에 넣으면 해결됩니다.",
      429,
    );
  }

  // 키가 있는데도 전부 실패했다. 1순위(키 기반) 소스가 왜 실패했는지가 핵심이므로
  // 마지막 소스 메시지로 덮지 않고 소스별 사유를 전부 보여준다.
  const primary = attempts[0];
  if (primary?.status === 429) {
    throw new DataProviderError(
      "시세 서버가 요청을 제한하고 있어 지금은 데이터를 가져올 수 없습니다. " +
        `잠시 후 다시 시도해 주세요. (${detail})`,
      429,
    );
  }
  throw new DataProviderError(`시세를 가져오지 못했습니다 — ${detail}`, primary?.status ?? 502);
}

export type LoadOptions = {
  forceFresh?: boolean;
  /** 몇 년치를 받을지. 기본 5년. 사이클 분석은 길게 요청한다. */
  years?: number;
};

export async function loadBars(ticker: string, opts: LoadOptions = {}): Promise<Bar[]> {
  const years = Math.min(MAX_YEARS, Math.max(1, Math.round(opts.years ?? DEFAULT_YEARS)));
  // 기본 기간은 기존 캐시 키를 그대로 쓴다 (배포 직후 캐시가 통째로 비지 않게).
  const cacheYears = years === DEFAULT_YEARS ? undefined : years;
  const cached = await getCachedBars(ticker, cacheYears);
  const cacheOk =
    cached &&
    (opts.forceFresh ? false : cached.fresh) &&
    !(isCryptoTicker(ticker) && !hasUsableVolume(cached.bars));
  if (cacheOk && cached) return cached.bars;

  try {
    const bars = await fetchFromChain(ticker, years);
    await setCachedBars(ticker, bars, cacheYears);
    return bars;
  } catch (e) {
    if (cached && !(isCryptoTicker(ticker) && !hasUsableVolume(cached.bars))) return cached.bars;
    throw e;
  }
}
