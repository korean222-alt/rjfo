import type { Bar } from "@/types";
import type { DataProvider } from "./provider";

/**
 * 오프라인 데모/스모크 테스트용 합성 데이터 소스.
 * DATA_PROVIDER=fixture 일 때만 쓰인다. 실제 시세가 아니다.
 */
export class FixtureProvider implements DataProvider {
  readonly name = "fixture";

  async getDailyBars(ticker: string, years: number): Promise<Bar[]> {
    const days = Math.round(years * 252);
    // 티커 문자열로 시드를 만들어 같은 티커면 항상 같은 결과가 나오게 한다.
    let seed = 0;
    for (const ch of ticker) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    const bars: Bar[] = [];
    let close = 100;
    const start = new Date(Date.UTC(2020, 0, 6)); // 월요일

    for (let i = 0, d = 0; i < days; d++) {
      const day = new Date(start.getTime() + d * 86400000);
      const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue; // 주말 제외 (휴장일 근사)

      const drift = 0.0004;
      const shock = (rand() - 0.5) * 0.03;
      const spike = rand() > 0.97; // 가끔 거래량 폭발
      const changePct = drift + shock + (spike ? (rand() - 0.4) * 0.05 : 0);

      const prev = close;
      close = prev * (1 + changePct);
      const high = Math.max(prev, close) * (1 + rand() * 0.012);
      const low = Math.min(prev, close) * (1 - rand() * 0.012);
      const volume = Math.round(
        (spike ? 3_000_000 + rand() * 6_000_000 : 800_000 + rand() * 900_000),
      );

      bars.push({
        date: day.toISOString().slice(0, 10),
        open: prev,
        high,
        low,
        close,
        volume,
      });
      i++;
    }
    return bars;
  }
}
