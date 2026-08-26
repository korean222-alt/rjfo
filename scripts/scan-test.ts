/**
 * 펀딩 집계 · 급등/이평 스캔 · AI 명령 파싱.
 *   npx tsx scripts/scan-test.ts
 */
import { toDailyFunding } from "../lib/data/funding";
import { enrich } from "../lib/indicators";
import { parseAssistantIntent } from "../lib/assistant-intent";
import { scanMaBreakout, scanSurgePrelude } from "../lib/scan";
import { applyFilter } from "../lib/filter";
import { PRESET_CONDITIONS } from "../lib/presets";
import type { Bar } from "../types";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

console.log("\n[1] 펀딩 8시간을 일평균으로");
{
  const daily = toDailyFunding([
    { t: Date.UTC(2026, 0, 1, 0), rate: 0.0001 },
    { t: Date.UTC(2026, 0, 1, 8), rate: 0.0002 },
    { t: Date.UTC(2026, 0, 1, 16), rate: 0.0003 },
    { t: Date.UTC(2026, 0, 2, 0), rate: -0.0002 },
  ]);
  assert(Math.abs((daily.get("2026-01-01") ?? 0) - 0.0002) < 1e-12, "1월 1일 평균 0.0002");
  assert((daily.get("2026-01-02") ?? 0) < 0, "1월 2일 음수");
}

console.log("\n[2] 급등 전 거래량 스캔");
{
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < 80; i++) {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    const volume = i >= 30 && i < 40 ? 3_000_000 : 1_000_000;
    if (i >= 40 && i < 48) close *= 1.02; // ~16% in 8 days
    bars.push({
      date,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume,
      funding: i % 2 === 0 ? 0.0002 : 0.00005,
    });
  }
  const enriched = enrich(bars);
  const scan = scanSurgePrelude(enriched, { windowDays: 10, minReturnPct: 10, lookbackDays: 10 });
  assert(scan.events.length >= 1, `급등 구간 ${scan.events.length}개`);
  const first = scan.events[0];
  assert(first.lookback.some((d) => (d.volumeRatio ?? 0) > 1.5), "급등 전 거래량 배수 상승");
  assert(scan.markers[0].date === first.date, "마커 날짜 = 급등 시작");
}

console.log("\n[3] 이평선 돌파 스캔");
{
  const bars: Bar[] = [];
  for (let i = 0; i < 80; i++) {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    const close = i < 50 ? 100 - i * 0.4 : 95 + (i - 50) * 0.2;
    bars.push({ date, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1_000_000 });
  }
  const enriched = enrich(bars);
  const scan = scanMaBreakout(enriched, { period: 20, holdDays: 5, direction: "up" });
  assert(scan.events.length >= 1, `돌파 ${scan.events.length}회`);
  assert(scan.markers.every((m) => m.label.includes("20일")), "마커 라벨에 기간");
}

console.log("\n[4] 한국어 명령 파싱");
{
  const a = parseAssistantIntent("오라클 10일만에 10%이상 급등 20일전 거래량들 전부 분석해줘");
  assert(a.kind === "surge_prelude", `급등 의도 (${a.kind})`);
  if (a.kind === "surge_prelude") {
    assert(a.ticker === "ORCL", `티커 ${a.ticker}`);
    assert(a.windowDays === 10, `window ${a.windowDays}`);
    assert(a.minReturnPct === 10, `min ${a.minReturnPct}`);
    assert(a.lookbackDays === 20, `lookback ${a.lookbackDays}`);
  }
  const b = parseAssistantIntent("지금까지 200일 이평선 돌파 30일 후 어떻게됐어?");
  assert(b.kind === "ma_breakout", `돌파 의도 (${b.kind})`);
  if (b.kind === "ma_breakout") {
    assert(b.period === 200, `period ${b.period}`);
    assert(b.holdDays === 30, `hold ${b.holdDays}`);
    assert(b.direction === "up", "상향");
  }
  assert(parseAssistantIntent("표시해줘").kind === "mark", "표시");
  assert(parseAssistantIntent("표시 끄기").kind === "clear", "지우기");
}

console.log("\n[5] 펀딩 과열 필터");
{
  const bars: Bar[] = [];
  for (let i = 0; i < 90; i++) {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    const funding = i === 80 ? 0.002 : 0.0001;
    bars.push({
      date,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000_000,
      funding,
    });
  }
  const enriched = enrich(bars);
  assert(enriched[80].funding_pct != null && enriched[80].funding_pct > 0.1, "80번째 펀딩% 큼");
  assert((enriched[80].funding_zscore_60d ?? 0) > 1.5, `z ${enriched[80].funding_zscore_60d}`);
  const hits = applyFilter(enriched, {
    conditions: PRESET_CONDITIONS.funding_heat,
    logic: "AND",
    interpretation: "펀딩 과열",
    confidence: "high",
  });
  assert(hits.includes(80), "과열 프리셋이 80번째를 잡음");
}

console.log(failures === 0 ? "\n✅ 전부 통과\n" : `\n❌ ${failures}개 실패\n`);
process.exit(failures === 0 ? 0 : 1);
