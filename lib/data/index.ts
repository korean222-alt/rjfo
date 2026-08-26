import type { Bar } from "@/types";
import { getCachedBars, setCachedBars } from "./cache";
import { FixtureProvider } from "./fixture";
import { DataProviderError, type DataProvider } from "./provider";
import { StooqProvider } from "./stooq";
import { toStooqCryptoSymbol, toTwelveSymbol } from "./symbols";
import { TwelveDataProvider, twelveDataKey } from "./twelvedata";
import { YahooProvider } from "./yahoo";

const YEARS = 5;

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

export function getProviders(): DataProvider[] {
  const twelve = new MappedProvider(new TwelveDataProvider(), toTwelveSymbol);
  const yahoo = new YahooProvider();
  const stooq = new MappedProvider(
    new StooqProvider(),
    (ticker) => toStooqCryptoSymbol(ticker) ?? ticker,
  );

  switch (process.env.DATA_PROVIDER) {
    case "fixture":
      return [new FixtureProvider()];
    case "stooq":
      return [stooq];
    case "yahoo":
      return [yahoo];
    case "twelvedata":
      return [twelve];
    default:
      return twelveDataKey() ? [twelve, yahoo, stooq] : [yahoo, stooq];
  }
}

export function getProvider(): DataProvider {
  return getProviders()[0];
}

async function fetchFromChain(ticker: string): Promise<Bar[]> {
  const providers = getProviders();
  let notFound: DataProviderError | null = null;
  let lastError: unknown = null;

  for (const provider of providers) {
    try {
      return await provider.getDailyBars(ticker, YEARS);
    } catch (e) {
      lastError = e;
      if (e instanceof DataProviderError && e.status === 404 && !notFound) {
        notFound = e;
      }
    }
  }

  if (notFound) throw notFound;

  if (!twelveDataKey()) {
    const cause = (lastError as Error)?.message ?? "알 수 없는 오류";
    throw new DataProviderError(
      `무료 시세 소스가 모두 막혔습니다 (${cause}) ` +
        "twelvedata.com에서 무료 API 키를 발급받아 환경변수 TWELVE_DATA_API_KEY에 넣으면 해결됩니다.",
      429,
    );
  }

  if (lastError instanceof DataProviderError && lastError.status === 429) {
    throw new DataProviderError(
      "시세 서버가 요청을 제한하고 있어 지금은 데이터를 가져올 수 없습니다. 잠시 후 다시 시도해 주세요.",
      429,
    );
  }
  if (lastError instanceof DataProviderError) throw lastError;
  throw new DataProviderError(
    `시세를 가져오지 못했습니다: ${(lastError as Error)?.message ?? "알 수 없는 오류"}`,
    502,
  );
}

export type LoadOptions = {
  forceFresh?: boolean;
};

export async function loadBars(ticker: string, opts: LoadOptions = {}): Promise<Bar[]> {
  const cached = await getCachedBars(ticker);
  if (cached?.fresh && !opts.forceFresh) return cached.bars;

  try {
    const bars = await fetchFromChain(ticker);
    await setCachedBars(ticker, bars);
    return bars;
  } catch (e) {
    if (cached) return cached.bars;
    throw e;
  }
}
