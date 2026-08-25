import type { Bar } from "@/types";
import { getCachedBars, setCachedBars } from "./cache";
import { FixtureProvider } from "./fixture";
import { DataProviderError, type DataProvider } from "./provider";
import { StooqProvider } from "./stooq";
import { TwelveDataProvider, twelveDataKey } from "./twelvedata";
import { YahooProvider } from "./yahoo";

const YEARS = 5; // 통계에 의미 있는 표본을 위한 최소 기간

/**
 * 데이터 소스 체인. 앞에서부터 시도하고 실패하면 다음으로 넘어간다.
 *
 * 키 기반 소스(Twelve Data)가 있으면 그게 1순위다. Yahoo·Stooq는 키가 필요 없는
 * 대신 **IP만 보고 막는다**. 실제 배포에서 Yahoo는 429, Stooq는 CSV 대신 봇 차단
 * 페이지를 돌려줬다. 키 기반 소스는 IP가 아니라 키로 식별하므로 이 문제가 없다.
 *
 * 전부 실패하면 만료된 캐시라도 내보낸다(loadBars 참고).
 *
 * 주의: env는 반드시 호출 시점에 읽는다. 모듈 최상위에서 읽으면 Next가
 * 빌드 타임에 값을 인라인해 버려서 배포 환경변수가 무시된다.
 */
export function getProviders(): DataProvider[] {
  switch (process.env.DATA_PROVIDER) {
    case "fixture":
      return [new FixtureProvider()]; // 네트워크 없이 돌려보는 오프라인 데모용
    case "stooq":
      return [new StooqProvider()];
    case "yahoo":
      return [new YahooProvider()];
    case "twelvedata":
      return [new TwelveDataProvider()];
    default:
      return twelveDataKey()
        ? [new TwelveDataProvider(), new YahooProvider(), new StooqProvider()]
        : [new YahooProvider(), new StooqProvider()];
  }
}

/** 하위 호환 — 체인의 첫 소스. */
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
      // 소스 하나가 막힌 것뿐이면 다음 소스로 계속 간다.
    }
  }

  // 한 소스라도 "그런 티커 없다"고 했으면 그게 가장 정확한 원인이다.
  if (notFound) throw notFound;

  // 키 없는 소스만 있는데 전부 막혔다면, 원인은 이 티커가 아니라 서버 IP 차단이다.
  // 사용자가 할 수 있는 조치를 알려준다.
  if (!twelveDataKey()) {
    // 원인을 지우지 않는다. 조치 방법과 실제 실패 사유를 함께 준다.
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
  /**
   * 캐시가 아직 fresh여도 무시하고 새로 받는다.
   * 알림 크론처럼 "오늘 봉이 반드시 들어있어야" 하는 경로에서만 쓴다.
   * 외부 소스가 전부 막히면 평소처럼 캐시로 떨어진다.
   */
  forceFresh?: boolean;
};

/** 캐시 우선. 외부 API는 캐시 미스일 때만 호출한다 (rate limit 방지). */
export async function loadBars(ticker: string, opts: LoadOptions = {}): Promise<Bar[]> {
  const cached = await getCachedBars(ticker);
  if (cached?.fresh && !opts.forceFresh) return cached.bars;

  try {
    const bars = await fetchFromChain(ticker);
    await setCachedBars(ticker, bars);
    return bars;
  } catch (e) {
    // 외부 소스가 전부 막혔을 때, 만료된 캐시가 있으면 에러보다 낫다.
    if (cached) return cached.bars;
    throw e;
  }
}
