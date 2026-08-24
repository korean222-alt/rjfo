import type { Bar } from "@/types";
import { getCachedBars, setCachedBars } from "./cache";
import { FixtureProvider } from "./fixture";
import type { DataProvider } from "./provider";
import { YahooProvider } from "./yahoo";

const YEARS = 5; // 통계에 의미 있는 표본을 위한 최소 기간

/**
 * 여기만 바꾸면 유료 소스로 교체된다 (어댑터 패턴).
 * DATA_PROVIDER=fixture 는 네트워크 없이 돌려보는 오프라인 데모용.
 *
 * 주의: env는 반드시 호출 시점에 읽는다. 모듈 최상위에서 읽으면 Next가
 * 빌드 타임에 값을 인라인해 버려서 배포 환경변수가 무시된다.
 */
export function getProvider(): DataProvider {
  return process.env.DATA_PROVIDER === "fixture"
    ? new FixtureProvider()
    : new YahooProvider();
}

/** 캐시 우선. 외부 API는 캐시 미스일 때만 호출한다 (rate limit 방지). */
export async function loadBars(ticker: string): Promise<Bar[]> {
  const cached = await getCachedBars(ticker);
  if (cached) return cached;

  const bars = await getProvider().getDailyBars(ticker, YEARS);
  await setCachedBars(ticker, bars);
  return bars;
}
