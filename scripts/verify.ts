/**
 * 실데이터로 1~2단계(데이터 레이어 + 지표 + 통계)를 콘솔에서 검증한다.
 *   npx tsx scripts/verify.ts AAPL
 *   DATA_PROVIDER=fixture npx tsx scripts/verify.ts DEMO   # 네트워크 없이
 */
import { enrich } from "../lib/indicators";
import { analyze } from "../lib/stats";
import { FixtureProvider } from "../lib/data/fixture";
import { YahooProvider } from "../lib/data/yahoo";
import { PRESET_CONDITIONS } from "../lib/presets";
import type { FilterSpec } from "../types";

const ticker = (process.argv[2] || "AAPL").toUpperCase();
const useFixture = process.env.DATA_PROVIDER === "fixture";

function fmt(n: number | null, d = 2): string {
  return n == null || !isFinite(n) ? "—" : n.toFixed(d);
}

async function main() {
  const provider = useFixture ? new FixtureProvider() : new YahooProvider();
  console.log(`\n■ 소스: ${provider.name} / 티커: ${ticker}\n`);

  const bars = await provider.getDailyBars(ticker, 5);
  console.log(`일봉 ${bars.length}개  (${bars[0].date} ~ ${bars[bars.length - 1].date})`);

  // 1) 원본 데이터 눈으로 확인
  console.log("\n[최근 5봉]");
  console.table(
    bars.slice(-5).map((b) => ({
      date: b.date,
      open: +b.open.toFixed(2),
      high: +b.high.toFixed(2),
      low: +b.low.toFixed(2),
      close: +b.close.toFixed(2),
      volume: b.volume.toLocaleString(),
    })),
  );

  // 2) 지표 확인 — 거래량 상위 5일
  const e = enrich(bars);
  const topVolume = [...e].sort((a, b) => b.volume - a.volume).slice(0, 5);
  console.log("\n[거래량 상위 5일 — 지표 검산용]");
  console.table(
    topVolume.map((b) => ({
      date: b.date,
      volume: b.volume.toLocaleString(),
      vol_ma20: b.vol_ma20 ? Math.round(b.vol_ma20).toLocaleString() : "—",
      ratio_20d: fmt(b.volume_ratio_20d),
      zscore_60d: fmt(b.volume_zscore_60d),
      chg_pct: fmt(b.close_change_pct),
      close_pos: fmt(b.close_position_in_range),
      obv_slope: fmt(b.obv_slope_20d),
      atr14: fmt(b.atr14),
    })),
  );

  // 손 검산: 특정 날짜의 vol_ma20을 직접 다시 계산
  const idx = e.length - 1;
  const manual =
    bars.slice(idx - 19, idx + 1).reduce((a, b) => a + b.volume, 0) / 20;
  console.log(
    `\n검산: 마지막 봉 vol_ma20 = ${Math.round(manual).toLocaleString()} ` +
      `(구현값 ${Math.round(e[idx].vol_ma20 ?? 0).toLocaleString()}) → ` +
      (Math.abs(manual - (e[idx].vol_ma20 ?? 0)) < 1e-6 ? "일치 ✓" : "불일치 ✗"),
  );

  // 3) 통계 엔진 — 프리셋 3종을 하드코딩된 FilterSpec으로 돌려본다
  for (const [name, conditions] of Object.entries(PRESET_CONDITIONS)) {
    const spec: FilterSpec = {
      conditions,
      logic: "AND",
      preset: name as FilterSpec["preset"],
      interpretation: name,
      confidence: "high",
    };
    const r = analyze(ticker, e, spec);
    console.log(`\n[preset: ${name}]`);
    console.log(
      `  매칭 ${r.stats.matchCount}일 | 승률 ${fmt(r.stats.hitRate, 1)}% ` +
        `(전체 ${fmt(r.baseline.hitRate, 1)}%) → 차이 ${fmt(r.edge.hitRateDiff, 1)}%p`,
    );
    console.log(
      `  평균 20일 수익률 ${fmt(r.stats.avgReturn20d)}% ` +
        `(전체 ${fmt(r.baseline.avgReturn20d)}%) → 차이 ${fmt(r.edge.avgReturnDiff)}%p`,
    );
    if (r.matches.length) {
      console.log(
        `  최근 매칭: ${r.matches
          .slice(0, 3)
          .map((m) => `${m.date}(${fmt(m.volumeRatio)}배, 20일 ${fmt(m.forwardReturns.d20)}%)`)
          .join(", ")}`,
      );
    }
    r.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }
  console.log();
}

main().catch((e) => {
  console.error(`\n실패: ${e.message}\n`);
  process.exit(1);
});
