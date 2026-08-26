/**
 * 펀딩 집계 · 급등/이평 스캔 · AI 명령 파싱.
 *   npx tsx scripts/scan-test.ts
 */
import { toDailyFunding } from "../lib/data/funding";
import { enrich } from "../lib/indicators";
import { parseAssistantIntent } from "../lib/assistant-intent";
import { isCryptoTicker, normalizeTicker } from "../lib/data/provider";
import { parseMaCommand } from "../lib/ma";
import { parseLocalCommand } from "../lib/parse-local";
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
  const c = parseAssistantIntent("365일선 돌파 할때 차트에 표시해줘");
  assert(c.kind === "ma_breakout", `365 돌파 의도 (${c.kind})`);
  if (c.kind === "ma_breakout") assert(c.period === 365, `365 period ${c.period}`);
  const d = parseAssistantIntent("ma 365일선 차트에 표시해줘");
  assert(d.kind === "draw_ma", `선만 그리기 (${d.kind})`);
  if (d.kind === "draw_ma") assert(d.period === 365, `draw 365 ${d.period}`);
  const e = parseAssistantIntent("MA 200일선 돌파 30일 후");
  assert(e.kind === "ma_breakout" && !(e.kind === "ma_breakout" && e.ticker === "MA"), "MA를 티커로 오인하지 않음");
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

console.log("\n[6] 펀딩 극단 숏은 펀딩이 음수일 때만");
{
  const bars: Bar[] = [];
  for (let i = 0; i < 90; i++) {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    // 대부분 +0.0003, 마지막만 +0.00005 → z는 크게 음수지만 여전히 롱 지불
    const funding = i === 80 ? 0.00005 : 0.0003;
    bars.push({ date, open: 100, high: 101, low: 99, close: 100, volume: 1_000_000, funding });
  }
  const stillLong = enrich(bars);
  const shortHits = applyFilter(stillLong, {
    conditions: PRESET_CONDITIONS.funding_short,
    logic: "AND",
    interpretation: "펀딩 극단 숏",
    confidence: "high",
  });
  assert(!shortHits.includes(80), "플러스 펀딩은 극단 숏이 아님");
  assert((stillLong[80].funding_zscore_60d ?? 0) < -1.5, "z는 음수여도");
  assert((stillLong[80].funding_pct ?? 0) > 0, "펀딩 자체는 플러스");

  const neg: Bar[] = bars.map((b, i) => ({ ...b, funding: i === 80 ? -0.002 : 0.0001 }));
  const shorted = enrich(neg);
  const realShort = applyFilter(shorted, {
    conditions: PRESET_CONDITIONS.funding_short,
    logic: "AND",
    interpretation: "펀딩 극단 숏",
    confidence: "high",
  });
  assert(realShort.includes(80), "마이너스 펀딩 + 극단 z 는 숏 신호");
}

console.log("\n[7] 로컬 명령 파싱 (Gemini 없이)");
{
  const label = parseLocalCommand("거래량 폭발");
  const first = label?.conditions[0];
  assert(Boolean(first && "metric" in first && first.metric === "volume_ratio_20d"), "칩 라벨 매칭");
  assert((label?.conditions[0] as { value?: number }).value === 3, "거래량 폭발 3배");

  const free = parseLocalCommand("거래량이 평균의 두 배 넘고 종가가 오른 날");
  assert(free?.conditions.length === 2, `배수+상승 조건 ${free?.conditions.length}`);
  const metrics = (free?.conditions ?? []).map((c) => ("metric" in c ? c.metric : c.kind));
  assert(metrics.includes("volume_ratio_20d") && metrics.includes("close_change_pct"), "거래량 배수 + 종가 상승");

  const heat = parseLocalCommand("비트코인 펀딩 과열인 날 찾아줘");
  assert(heat?.preset === "funding_heat", `펀딩 과열 preset ${heat?.preset}`);

  const none = parseLocalCommand("내일 오를 종목 찍어줘");
  assert(none === null, "애매한 문장은 Gemini로 넘긴다");
  assert(normalizeTicker("SOL") === "SOL-USD" && isCryptoTicker("SOL-USD"), "SOL 별칭");
  assert(normalizeTicker("도지") === "DOGE-USD", "도지 별칭");
  assert(normalizeTicker("005930") === "005930.KS", "한국 6자리 → .KS");
  assert(normalizeTicker("삼성전자") === "005930.KS", "삼성전자 별칭");
  assert(normalizeTicker("005930.KQ") === "005930.KQ", "이미 붙은 KOSDAQ 접미사는 유지");
}

console.log("\n[8] 이평선 돌파 명령은 Gemini 없이");
{
  const a = parseMaCommand("365일 이평선 돌파");
  const c0 = a?.conditions[0];
  assert(a != null && c0?.kind === "ma_breakout", "365일 이평선 돌파");
  if (c0?.kind === "ma_breakout") {
    assert(c0.period === 365 && c0.direction === "up", `365 상향 ${c0.period}/${c0.direction}`);
  }
  const b = parseMaCommand("365일선 돌파");
  assert(b?.conditions[0]?.kind === "ma_breakout", "365일선 돌파");
  const c = parseMaCommand("200일 이동평균선 하향 돌파");
  const cc = c?.conditions[0];
  assert(cc?.kind === "ma_breakout" && cc.direction === "down" && cc.period === 200, "하향 돌파");
  const d = parseMaCommand("이평선 돌파");
  const dd = d?.conditions[0];
  assert(dd?.kind === "ma_breakout" && dd.period === 200, "이평선만 있으면 200일");
  assert(parseMaCommand("강한 돌파") === null, "거래량 강한 돌파는 이평 파서가 안 먹음");
  assert(parseMaCommand("200일선 터치")?.conditions[0]?.kind === "ma_touch", "터치는 그대로");
}

console.log(failures === 0 ? "\n✅ 전부 통과\n" : `\n❌ ${failures}개 실패\n`);
process.exit(failures === 0 ? 0 : 1);
