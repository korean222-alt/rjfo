/**
 * 사이클 분석 검산.
 *   npx tsx scripts/cycle-test.ts            # 합성 데이터 (네트워크 불필요)
 *   npx tsx scripts/cycle-test.ts BTC-USD    # 실데이터로 리포트 출력
 *
 * 합성 파트는 바닥 위치를 미리 아는 시계열을 만들어, 라벨러가 그 바닥을
 * 정확히 찍는지 본다. 라벨링이 틀리면 나머지 통계는 전부 무의미하다.
 */
import { enrich } from "../lib/indicators";
import { analyzeCycle, completedStarts, snapshotOnPct } from "../lib/cycle";
import { findCycles, findPivots, STOCK_THRESHOLDS, CRYPTO_THRESHOLDS } from "../lib/cycle/regime";
import {
  circularShiftP,
  eventIndices,
  evaluateSignal,
  exclusiveCycleBounds,
  cycleWindowShare,
  windowMask,
  DEFAULT_WINDOW,
  baselineStats,
} from "../lib/cycle/evaluate";
import { andState } from "../lib/cycle/combos";
import { fdrQValues } from "../lib/cycle/grade";
import { toMonthly, toWeekly, projectToDaily, barsForView, snapDatesToView } from "../lib/cycle/resample";
import { ema, macd, rsi, sma } from "../lib/cycle/ta";
import { narrate } from "../lib/cycle/narrative";
import { plotForSignal, plotForView } from "../lib/cycle/plot";
import { buildSignals } from "../lib/cycle/signals";
import { toTradingViewSymbol } from "../lib/tradingview";
import type { Bar } from "../types";

let failures = 0;

function assert(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

function approx(actual: number | null, expected: number, tol: number, label: string) {
  if (actual == null || Math.abs(actual - expected) > tol) {
    console.error(`  ✗ ${label}: 기대 ≈${expected}, 실제 ${actual}`);
    failures++;
  } else {
    console.log(`  ✓ ${label}: ${actual.toFixed(4)}`);
  }
}

function dateAt(i: number): string {
  return new Date(Date.UTC(2010, 0, 1 + i)).toISOString().slice(0, 10);
}

/** 종가 배열 → 봉. 고가/저가는 종가 ±0.5%. */
function barsFromCloses(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    date: dateAt(i),
    open: i === 0 ? c : closes[i - 1],
    high: c * 1.005,
    low: c * 0.995,
    close: c,
    volume: 1_000_000,
  }));
}

// ── 1. 지그재그 라벨러 ────────────────────────────────────────────
console.log("\n[1] 상승장 시작 라벨링");
{
  // 100 → 200(고점) → 80(바닥) → 300(고점) → 150(바닥) → 400
  const closes: number[] = [];
  const ramp = (from: number, to: number, days: number) => {
    for (let i = 1; i <= days; i++) closes.push(from + ((to - from) * i) / days);
  };
  closes.push(100);
  ramp(100, 200, 100); // idx 1..100, 고점 idx 100
  ramp(200, 80, 100); // 바닥 idx 200
  ramp(80, 300, 150); // 고점 idx 350
  ramp(300, 150, 100); // 바닥 idx 450
  ramp(150, 400, 150); // idx 451..600

  const bars = barsFromCloses(closes);
  const t = { bearPct: 30, bullPct: 30 };

  const pivots = findPivots(bars, t);
  assert(pivots.length === 4, `피벗 4개 (실제 ${pivots.length})`);
  assert(pivots[0]?.kind === "peak" && pivots[0].idx === 100, "첫 고점 idx=100");
  assert(pivots[1]?.kind === "trough" && pivots[1].idx === 200, "첫 바닥 idx=200");
  assert(pivots[2]?.kind === "peak" && pivots[2].idx === 350, "둘째 고점 idx=350");
  assert(pivots[3]?.kind === "trough" && pivots[3].idx === 450, "둘째 바닥 idx=450");

  const cycles = findCycles(bars, t);
  assert(cycles.length === 2, `사이클 2개 (실제 ${cycles.length})`);
  assert(cycles[0].closed && cycles[0].nextPeakDate === dateAt(350), "1번 사이클은 idx350에서 닫힘");
  assert(!cycles[1].closed, "2번 사이클은 진행 중 (아직 -30% 되밀림 없음)");
  approx(cycles[0].drawdownPct, -60, 0.001, "1번 사이클 낙폭 -60%");
  approx(cycles[0].gainPct, 275, 0.001, "1번 사이클 바닥→고점 +275%");
}

// ── 2. 임계값을 못 넘으면 사이클이 없어야 한다 ────────────────────
console.log("\n[2] 얕은 조정은 사이클로 세지 않는다");
{
  const closes: number[] = [];
  for (let i = 0; i < 400; i++) closes.push(100 + Math.sin(i / 20) * 5); // ±5% 진동
  const cycles = findCycles(barsFromCloses(closes), { bearPct: 30, bullPct: 30 });
  assert(cycles.length === 0, `사이클 0개 (실제 ${cycles.length})`);
}

// ── 3. 표준 지표 검산 ─────────────────────────────────────────────
console.log("\n[3] 지표 검산");
{
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const s = sma(v, 3);
  assert(s[0] === null && s[1] === null, "SMA(3) 앞 2개는 null");
  approx(s[2], 2, 1e-9, "SMA(3)[2] = (1+2+3)/3");
  approx(s[9], 9, 1e-9, "SMA(3)[9] = (8+9+10)/3");

  // EMA 시드는 첫 period의 단순평균
  const e = ema(v, 3);
  approx(e[2], 2, 1e-9, "EMA(3) 시드 = SMA(3)");
  approx(e[3], 2 + (4 - 2) * 0.5, 1e-9, "EMA(3)[3] = 시드 + (4-시드)*0.5");

  // 계속 오르기만 하면 RSI = 100
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  approx(rsi(up)[39], 100, 1e-6, "단조 상승 RSI = 100");
  const down = Array.from({ length: 40 }, (_, i) => 200 - i);
  approx(rsi(down)[39], 0, 1e-6, "단조 하락 RSI = 0");

  // MACD: 하락하다 idx 80에서 상승으로 꺾이는 시계열.
  //
  // "전환 직후 골든크로스"로 검산하지 않는 이유: 완벽한 직선 하락에서는
  // MACD와 시그널이 정확히 같은 값으로 수렴해서 크로스가 이미 일어난 상태가 된다
  // (실제 시세에는 노이즈가 있어 생기지 않는 상황이다). 대신 방향과 확대를 본다.
  const turn = [
    ...Array.from({ length: 80 }, (_, i) => 200 - i),
    ...Array.from({ length: 80 }, (_, i) => 120 + i * 1.5),
  ];
  const m = macd(turn);
  assert(m.macd[80] != null && m.macd[80]! < 0, "하락 구간 끝에서 MACD는 음수");
  const zeroCross = m.macd.findIndex(
    (v, i) => i > 80 && v != null && v > 0 && m.macd[i - 1] != null && m.macd[i - 1]! <= 0,
  );
  assert(zeroCross > 80 && zeroCross < 110, `전환 후 MACD 0선 상향 돌파 (idx ${zeroCross})`);
  assert(
    m.hist[85] != null && m.hist[95] != null && m.hist[95]! > m.hist[85]! && m.hist[85]! > 0,
    "전환 후 히스토그램이 확대된다",
  );
}

// ── 4. 리샘플링이 미래를 보지 않는지 ──────────────────────────────
console.log("\n[4] 주봉/월봉 미래 참조 방지");
{
  // 2010-01-01은 금요일. 20일치면 3~4주.
  const bars = barsFromCloses(Array.from({ length: 60 }, (_, i) => 100 + i));
  const w = toWeekly(bars);
  assert(w.bars.length >= 8, `주봉 ${w.bars.length}개 생성`);

  // 각 주봉의 종가는 그 주 마지막 일봉의 종가여야 한다.
  const lastOfFirstWeek = bars.filter((_, i) => w.periodOf[i] === 0).at(-1)!;
  approx(w.bars[0].close, lastOfFirstWeek.close, 1e-9, "주봉 종가 = 그 주 마지막 일봉 종가");

  // projectToDaily는 '직전에 마감된' 주의 값만 준다.
  const periodState = w.bars.map((_, i) => i);
  const daily = projectToDaily(w.periodOf, periodState, null);
  const firstWeekIdx = w.periodOf.findIndex((p) => p === 0);
  assert(daily[firstWeekIdx] === null, "첫 주에는 직전 주가 없어 null");
  const secondWeekStart = w.periodOf.findIndex((p) => p === 1);
  assert(daily[secondWeekStart] === 0, "둘째 주에는 첫 주(마감된 주)의 값이 붙는다");
  const secondWeekEnd = w.periodOf.lastIndexOf(1);
  assert(daily[secondWeekEnd] === 0, "둘째 주 마지막 날에도 여전히 첫 주 값 (진행 중인 주를 안 씀)");

  const mo = toMonthly(bars);
  assert(mo.bars.length >= 2, `월봉 ${mo.bars.length}개 생성`);
}

// ── 5. 신호 엣지 추출 ─────────────────────────────────────────────
console.log("\n[5] 신호 발생일 = 상태의 상승 엣지");
{
  const state: (boolean | null)[] = [null, null, false, false, true, true, false, true, false, true];
  //                                                        ↑idx4        ↑idx7(간격3, 묶임)  ↑idx9(간격2, 묶임)
  const ev = eventIndices(state);
  assert(ev.length === 1 && ev[0] === 4, `5거래일 안의 깜빡임은 하나로 (실제 ${JSON.stringify(ev)})`);

  const spaced: (boolean | null)[] = new Array(40).fill(false);
  spaced[5] = true;
  spaced[20] = true;
  const ev2 = eventIndices(spaced);
  assert(ev2.length === 2, `충분히 떨어진 신호는 각각 센다 (실제 ${ev2.length})`);
}

// ── 6. 전체 파이프라인 스모크 ─────────────────────────────────────
console.log("\n[6] 전체 파이프라인");
{
  // 1번과 같은 모양이되 지표들이 계산될 만큼 충분히 길게.
  const closes: number[] = [100];
  const ramp = (from: number, to: number, days: number) => {
    for (let i = 1; i <= days; i++) {
      const base = from + ((to - from) * i) / days;
      closes.push(base * (1 + Math.sin(i / 7) * 0.01)); // 약간의 노이즈
    }
  };
  ramp(100, 400, 500);
  ramp(400, 120, 400);
  ramp(120, 900, 700);
  ramp(900, 350, 300);
  ramp(350, 1400, 600);

  const bars = enrich(barsFromCloses(closes));
  const report = analyzeCycle("TEST", bars, { thresholds: { bearPct: 30, bullPct: 30 } });

  assert(report.cycles.length === 2, `사이클 2개 (실제 ${report.cycles.length})`);
  assert(report.signals.length >= 20, `지표 ${report.signals.length}개 평가`);
  assert(
    report.signals.every((s) => s.hitRate == null || (s.hitRate >= 0 && s.hitRate <= 100)),
    "적중률은 0~100% 범위",
  );
  assert(
    report.signals.every((s) => s.hitCount <= report.cycles.length),
    "적중 횟수는 사이클 수를 넘을 수 없다",
  );
  assert(
    report.signals.every((s) => s.hitCount + s.alreadyOnCount <= report.cycles.length),
    "적중 + 이미켜짐은 사이클 수를 넘을 수 없다",
  );
  assert(
    report.signals.every((s) => s.inWindowEvents.length + s.falseAlarms === s.eventCount),
    "창 안 신호 + 오탐 = 전체 신호",
  );
  assert(
    report.signals.every((s) => s.cycleHits.filter((h) => h.hit).length === s.hitCount),
    "적중 횟수 = hit로 표시된 사이클 수",
  );
  assert(
    report.signals.every((s) => s.falseAlarms >= 0),
    "오탐 횟수는 음수가 될 수 없다",
  );
  assert(report.now.on <= report.now.total, "켜진 지표 수 ≤ 전체 지표 수");
  assert(report.warnings.length > 0, "경고 문구가 항상 붙는다");
  assert(narrate(report).length > 50, "요약 문장 생성");
  assert(report.cycleStarts.every((c) => typeof c.complete === "boolean"), "스냅샷에 complete");
  assert(
    report.cycleStarts.every((c) => Number.isFinite(c.onPct) && c.onPct === snapshotOnPct(c)),
    "onPct = on/total",
  );
  assert(
    completedStarts(report.cycleStarts, report.now.date).every((c) => c.complete),
    "평균에는 완성 스냅샷만",
  );
  assert(!narrate(report).includes("NaN"), "요약에 NaN 없음");

  // 구버전 캐시(complete/onPct 없음)는 오늘 측정된 마지막 항목만 빼고, 비율은 on/total로 복구.
  const legacy = [
    { troughDate: "2024-01-01", measuredDate: "2024-02-01", on: 21, total: 23 },
    { troughDate: "2026-07-29", measuredDate: "2026-08-30", on: 2, total: 30 },
  ] as unknown as Parameters<typeof completedStarts>[0];
  const legacyDone = completedStarts(legacy, "2026-08-30");
  assert(legacyDone.length === 1 && legacyDone[0].troughDate === "2024-01-01", "구캐시는 오늘 마지막만 제외");
  assert(Math.round(snapshotOnPct(legacy[1])) === 7, `구캐시 onPct 복구 ${snapshotOnPct(legacy[1])}`);

  // 상승 추세로 끝나는 시계열이니 200일선 위는 켜져 있어야 한다.
  const ma200 = report.signals.find((s) => s.key === "ma200");
  assert(ma200?.currentlyOn === true, "마지막이 상승 구간이면 200일선 위는 켜짐");

  console.log("\n  --- 상위 5개 지표 ---");
  for (const s of report.signals.slice(0, 5)) {
    console.log(
      `  ${s.label.padEnd(20)} 적중 ${s.hitCount}/${report.cycles.length}` +
        `  리드 ${s.medianLeadDays ?? "—"}일` +
        `  남은상승 ${s.medianCaptureSharePct?.toFixed(0) ?? "—"}%` +
        `  신호 ${s.eventCount}회`,
    );
  }
}

// ── 7. 지표마다 차트 그림이 있는지 ────────────────────────────────
//
// plotForSignal은 switch라서 키를 빠뜨리면 조용히 빈 차트가 나온다.
// 지표를 추가하고 그림을 안 만들면 여기서 걸린다.
console.log("\n[7] 지표별 차트 그림");
{
  const closes: number[] = [100];
  for (let i = 1; i < 1600; i++) {
    // 추세 + 진동 + 결정론적 노이즈. 모든 지표가 값을 갖도록 충분히 길게.
    closes.push(closes[i - 1] * (1 + 0.0004 + Math.sin(i / 90) * 0.004 + Math.sin(i * 2.3) * 0.006));
  }
  const bars = enrich(barsFromCloses(closes));
  const signals = buildSignals(bars);

  const missing: string[] = [];
  const empty: string[] = [];
  for (const sig of signals) {
    const plot = plotForSignal(sig.key, bars);
    const lines = [...plot.overlays, ...(plot.pane?.lines ?? [])];
    if (!lines.length || !plot.rule) {
      missing.push(sig.key);
      continue;
    }
    if (lines.every((l) => l.data.length === 0)) empty.push(sig.key);
  }
  assert(missing.length === 0, `모든 지표에 그림과 설명이 있다 (빠짐: ${missing.join(", ") || "없음"})`);
  assert(empty.length === 0, `그린 선에 값이 들어 있다 (빈 것: ${empty.join(", ") || "없음"})`);

  // 주봉 지표는 계단식이라 같은 값이 며칠씩 이어진다. 일봉 지표와 구분되는지 확인.
  const weekly = plotForSignal("w_ma30", bars);
  const wData = weekly.overlays[0].data;
  const distinct = new Set(wData.map((p) => p.value)).size;
  assert(
    distinct > 10 && distinct < wData.length / 2,
    `주봉선은 계단식 (${wData.length}개 점, 값 ${distinct}종)`,
  );

  // 오버레이는 가격 축과 같은 스케일이어야 캔들 위에 겹쳐진다.
  const ma200 = plotForSignal("ma200", bars).overlays[0].data;
  const last = ma200[ma200.length - 1].value;
  const lastClose = bars[bars.length - 1].close;
  assert(
    Math.abs(last / lastClose - 1) < 0.5,
    `200일선이 가격과 같은 스케일 (선 ${last.toFixed(1)} vs 종가 ${lastClose.toFixed(1)})`,
  );

  // MACD/RSI처럼 단위가 다른 지표는 별도 패널로 가야 한다.
  for (const key of ["macd_d", "macd_w", "macd_m", "rsi_d50", "rsi_w50", "stoch", "cci", "adx", "obv"]) {
    const plot = plotForSignal(key, bars);
    assert(plot.pane != null, `${key}는 별도 패널`);
  }
  for (const key of ["ma200", "gc_50_200", "ichimoku", "bb_mid", "high_52w", "hh_hl"]) {
    const plot = plotForSignal(key, bars);
    assert(plot.overlays.length > 0 && plot.pane == null, `${key}는 가격 위 오버레이`);
  }

  console.log(`  ✓ 지표 ${signals.length}개 전부 그림 있음`);
}

// ── 8. 차트 보기용 봉 (채점은 일봉, 차트만 주/월) ─────────────────
console.log("\n[8] 차트 보기: 일/주/월 + BTC 현물 심볼");
{
  assert(toTradingViewSymbol("BTC-USD") === "CRYPTO:BTCUSD", "BTC는 CRYPTO:BTCUSD 현물");
  assert(toTradingViewSymbol("BTC-USD") !== "BINANCE:BTCUSDT.P", "BTC는 선물이 아님");
  assert(toTradingViewSymbol("ETH-USD") === "CRYPTO:ETHUSD", "ETH도 CRYPTO 현물");
  assert(toTradingViewSymbol("005930.KS") === "KRX:005930", "삼성전자는 KRX");

  const bars = barsFromCloses(Array.from({ length: 400 }, (_, i) => 100 + i));
  assert(barsForView(bars, "1d") === bars, "일봉 보기는 원본 배열을 그대로 쓴다");
  const weekly = barsForView(bars, "1w");
  const monthly = barsForView(bars, "1M");
  assert(weekly.length < bars.length / 4, `주봉은 일봉보다 적다 (${weekly.length}/${bars.length})`);
  assert(monthly.length <= weekly.length, `월봉은 주봉보다 많지 않다 (${monthly.length}/${weekly.length})`);
  assert(weekly[0].open === bars[0].open, "주봉 시가 = 그 주 첫 일봉 시가");
  assert(weekly[0].date === toWeekly(bars).bars[0].date, "barsForView 주봉 날짜 = toWeekly");

  // 같은 주에 속한 두 날짜는 주봉 하나에만 찍힌다.
  const sameWeek = snapDatesToView([bars[0].date, bars[1].date], bars, "1w");
  assert(sameWeek.length === 1, `같은 주의 두 날짜는 마커 하나 (실제 ${sameWeek.length})`);
  assert(sameWeek[0] === weekly[toWeekly(bars).periodOf[0]].date, "스냅된 날짜는 그 주 마지막 거래일");
  assert(
    JSON.stringify(snapDatesToView([bars[0].date], bars, "1d")) === JSON.stringify([bars[0].date]),
    "일봉 보기에서는 날짜를 그대로 둔다",
  );

  const closes: number[] = [100];
  for (let i = 1; i < 1600; i++) {
    closes.push(closes[i - 1] * (1 + 0.0004 + Math.sin(i / 90) * 0.004 + Math.sin(i * 2.3) * 0.006));
  }
  const longBars = enrich(barsFromCloses(closes));
  const wBars = barsForView(longBars, "1w");
  const mBars = barsForView(longBars, "1M");

  const dailyMa = plotForView("ma200", longBars, "1d");
  const weeklyMa = plotForView("ma200", longBars, "1w");
  const monthlyMa = plotForView("ma200", longBars, "1M");
  assert(dailyMa.overlays[0].label.includes("일"), "일봉 200일선 라벨");
  assert(weeklyMa.overlays[0].label === "200주선", `주봉 200일선 → 200주선 (실제 ${weeklyMa.overlays[0].label})`);
  assert(monthlyMa.overlays[0].label === "200개월선", `월봉 200일선 → 200개월선 (실제 ${monthlyMa.overlays[0].label})`);
  assert(
    weeklyMa.overlays[0].data.length <= wBars.length,
    `주봉 그림 점은 주봉 수를 넘지 않는다 (${weeklyMa.overlays[0].data.length}/${wBars.length})`,
  );
  assert(
    monthlyMa.overlays[0].data.length <= mBars.length,
    `월봉 그림 점은 월봉 수를 넘지 않는다 (${monthlyMa.overlays[0].data.length}/${mBars.length})`,
  );

  // 주봉 전용 키를 주봉 화면에서 그리면 일봉에 계단으로 펼치지 않는다.
  const w30daily = plotForSignal("w_ma30", longBars);
  const w30weekly = plotForView("w_ma30", longBars, "1w");
  assert(w30weekly.overlays[0].label === "30주선", "주봉 화면의 30주선 라벨");
  assert(
    w30weekly.overlays[0].data.length < w30daily.overlays[0].data.length / 3,
    `주봉 보기 30주선은 주봉 개수 (${w30weekly.overlays[0].data.length} vs 일봉계단 ${w30daily.overlays[0].data.length})`,
  );

  const m12 = plotForView("m_ma12", longBars, "1M");
  assert(m12.overlays[0].label === "12개월선", "월봉 화면의 12개월선");

  const macdW = plotForView("macd_w", longBars, "1w");
  assert(macdW.pane != null, "주봉 MACD는 별도 패널");
  assert(
    (macdW.pane?.lines[0].data.length ?? 0) <= wBars.length,
    "주봉 MACD도 주봉 개수를 넘지 않는다",
  );

  // 채점은 봉 보기와 무관하게 일봉이다. (회귀: analyzeCycle 인자가 그대로)
  const report = analyzeCycle("TEST", longBars, { thresholds: { bearPct: 30, bullPct: 30 } });
  assert(report.totalBars === longBars.length, "채점 봉 수는 일봉 그대로");
}

// ── 9. 50주선 ──────────────────────────────────────────────────
console.log("\n[9] 50주선");
{
  // [7]과 같은 시계열: 추세 + 진동 + 결정론적 노이즈.
  const longCloses: number[] = [100];
  for (let i = 1; i < 1600; i++) {
    longCloses.push(
      longCloses[i - 1] * (1 + 0.0004 + Math.sin(i / 90) * 0.004 + Math.sin(i * 2.3) * 0.006),
    );
  }
  const longBars = enrich(barsFromCloses(longCloses));

  const keys = buildSignals(longBars).map((s) => s.key);
  assert(keys.includes("w_ma50"), "배터리에 50주선 있음");

  const plot = plotForSignal("w_ma50", longBars);
  assert(
    plot.overlays.length > 0 && plot.overlays[0].data.length > 0 && Boolean(plot.rule),
    "w_ma50 차트 오버레이와 설명 있음",
  );

  // 50주선은 30주선·200주선과 다른 선이어야 한다 (period 파싱이 틀리면 같아진다).
  const w50 = plotForSignal("w_ma50", longBars).overlays[0];
  const w30 = plotForSignal("w_ma30", longBars).overlays[0];
  const w200 = plotForSignal("w_ma200", longBars).overlays[0];
  assert(w50.label === "50주선", `50주선 라벨 (실제 "${w50.label}")`);
  assert(
    w50.data[w50.data.length - 1].value !== w30.data[w30.data.length - 1].value &&
      w50.data[w50.data.length - 1].value !== w200.data[w200.data.length - 1].value,
    "50주선 값이 30주선·200주선과 다름",
  );

  // 주봉 화면에서 50주선은 그 봉의 SMA(50)로 그린다 (일봉에 계단으로 펼치지 않는다).
  const viewed = plotForView("w_ma50", longBars, "1w");
  assert(viewed.overlays[0].label === "50주선", `주봉 보기에서도 50주선 (실제 "${viewed.overlays[0].label}")`);
  assert(
    viewed.overlays[0].data.length < w50.data.length / 4,
    "주봉 보기는 주봉 개수만큼만 점을 그린다",
  );
}

// ── 10. 기본 임계값은 얕은 반등을 상승장으로 세지 않는다 ──────────
console.log("\n[10] 얕은 반등은 기본 기준으로 상승장이 아니다");
{
  const rampTo = (closes: number[], to: number, days: number) => {
    const from = closes[closes.length - 1];
    for (let i = 1; i <= days; i++) closes.push(from + ((to - from) * i) / days);
  };

  const shallow: number[] = [100];
  rampTo(shallow, 120, 40); // 고점
  rampTo(shallow, 96, 40); // -20%
  rampTo(shallow, 121, 40); // 96 대비 +26%
  const stockShallow = findCycles(barsFromCloses(shallow), STOCK_THRESHOLDS);
  assert(stockShallow.length === 0, `주식 +26% 반등은 사이클 아님 (실제 ${stockShallow.length})`);

  const real: number[] = [100];
  rampTo(real, 120, 40);
  rampTo(real, 96, 40); // -20%
  rampTo(real, 140, 60); // 96 대비 +46%
  const stockReal = findCycles(barsFromCloses(real), STOCK_THRESHOLDS);
  assert(stockReal.length === 1, `주식 +46% 반등은 사이클 (실제 ${stockReal.length})`);

  const cryptoBounce: number[] = [100];
  rampTo(cryptoBounce, 200, 40);
  rampTo(cryptoBounce, 120, 40); // -40%
  rampTo(cryptoBounce, 185, 40); // 120 대비 +54%
  const cryptoShallow = findCycles(barsFromCloses(cryptoBounce), CRYPTO_THRESHOLDS);
  assert(cryptoShallow.length === 0, `코인 +54% 반등은 사이클 아님 (실제 ${cryptoShallow.length})`);

  const cryptoReal: number[] = [100];
  rampTo(cryptoReal, 200, 40);
  rampTo(cryptoReal, 120, 40); // -40%
  rampTo(cryptoReal, 220, 50); // 120 대비 +83%
  const cryptoOk = findCycles(barsFromCloses(cryptoReal), CRYPTO_THRESHOLDS);
  assert(cryptoOk.length === 1, `코인 +83% 반등은 사이클 (실제 ${cryptoOk.length})`);
}

// ── 11. 적중 판정: 이미 켜짐 / 창 비겹침 / 창 직전 엣지 ───────────
console.log("\n[11] 적중 판정 (이미 켜짐, 창 겹침 없음)");
{
  const n = 400;
  const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.1);
  const bars = enrich(barsFromCloses(closes));
  const cycles = [
    {
      peakDate: null,
      peakIdx: null,
      peakClose: null,
      troughDate: dateAt(100),
      troughIdx: 100,
      troughClose: bars[100].close,
      drawdownPct: -30,
      gainPct: 80,
      nextPeakDate: dateAt(220),
      nextPeakIdx: 220,
      nextPeakClose: bars[220].close,
      closed: true,
    },
    {
      peakDate: dateAt(220),
      peakIdx: 220,
      peakClose: bars[220].close,
      troughDate: dateAt(250),
      troughIdx: 250,
      troughClose: bars[250].close,
      drawdownPct: -30,
      gainPct: 50,
      nextPeakDate: null,
      nextPeakIdx: null,
      nextPeakClose: bars[n - 1].close,
      closed: false,
    },
  ];

  const bounds = exclusiveCycleBounds(cycles, n, DEFAULT_WINDOW);
  assert(bounds[0].hi < bounds[1].lo, `창이 안 겹친다 (${bounds[0].hi} < ${bounds[1].lo})`);
  assert(bounds[0].hi === Math.floor((100 + 250) / 2), `1번 창 끝은 중점 (실제 ${bounds[0].hi})`);

  const share = cycleWindowShare(n, cycles, DEFAULT_WINDOW);
  const naive =
    (Math.min(n - 1, 100 + 150) - Math.max(0, 100 - 20) + 1 +
      (Math.min(n - 1, 250 + 150) - Math.max(0, 250 - 20) + 1)) /
    n;
  assert(share < naive - 0.05, `비겹침 창 비율 ${share.toFixed(2)} < 겹친 창 ${naive.toFixed(2)}`);

  const baseline = baselineStats(bars);
  const alwaysOn = {
    key: "always",
    label: "항상 켜짐",
    group: "추세" as const,
    why: "test",
    timeframe: "일봉" as const,
    state: bars.map((_, i) => (i < 5 ? null : true)),
  };
  const always = evaluateSignal(bars, alwaysOn, cycles, baseline, share);
  assert(always.hitCount === 0, `항상 켜짐은 적중이 아니다 (실제 ${always.hitCount})`);
  assert(always.alreadyOnCount === 2, `둘 다 '이미 켜짐'으로만 기록 (실제 ${always.alreadyOnCount})`);
  assert(always.cycleHits.every((h) => !h.hit), "항상 켜짐은 어떤 사이클도 hit가 아니다");
  assert(always.eventCount === 0, `상승 엣지가 없으면 신호 0회 (실제 ${always.eventCount})`);
  assert(always.score < 50, `항상 켜짐은 순위에서 빠진다 (score ${always.score.toFixed(1)})`);

  // 창 시작(trough-20=80)보다 앞인 idx 78에서 켜져 바닥까지 유지.
  const earlyState: (boolean | null)[] = bars.map(() => false);
  for (let i = 78; i < n; i++) earlyState[i] = true;
  const early = evaluateSignal(
    bars,
    { ...alwaysOn, key: "early", label: "창 직전 점등", state: earlyState },
    cycles,
    baseline,
    share,
  );
  assert(early.hitCount === 0, `창 밖 점등은 적중이 아니다 (실제 ${early.hitCount})`);
  assert(early.cycleHits[0].alreadyOn === true, "1번 사이클은 '이미 켜짐'");
  assert(early.cycleHits[0].hit === false, "'이미 켜짐'은 적중으로 세지 않는다");
  assert(early.cycleHits[0].eventDate != null, "언제 켜졌는지는 남긴다");
  assert(early.falseAlarms === 1, `창 밖 점등은 오탐 (실제 ${early.falseAlarms})`);

  // 창 안(바닥 10일 전)에서 켜졌다가 바닥 전에 꺼짐 → 선행 적중이어야 한다.
  const leadState: (boolean | null)[] = bars.map(() => false);
  leadState[90] = true;
  leadState[91] = true;
  const leadEval = evaluateSignal(
    bars,
    { ...alwaysOn, key: "lead", label: "바닥 전 점등", state: leadState },
    cycles,
    baseline,
    share,
  );
  assert(leadEval.cycleHits[0].hit === true, "바닥 20일 전 창 안 점등도 적중");
  assert(leadEval.cycleHits[0].leadDays === -10, `리드 -10일 (실제 ${leadEval.cycleHits[0].leadDays})`);

  // 각 바닥 직후에만 짧게 점등. 창이 안 겹치니 신호가 서로 다른 사이클에 귀속.
  const timed: (boolean | null)[] = bars.map(() => false);
  timed[110] = true;
  timed[111] = true;
  timed[260] = true;
  timed[261] = true;
  const timedEval = evaluateSignal(
    bars,
    { ...alwaysOn, key: "timed", label: "바닥 직후", state: timed },
    cycles,
    baseline,
    share,
  );
  assert(timedEval.hitCount === 2, `바닥 직후 점등은 두 사이클 모두 적중 (실제 ${timedEval.hitCount})`);
  assert(timedEval.alreadyOnCount === 0, "바닥 당시에는 꺼져 있었고 직후 켜짐");
  assert(timedEval.falseAlarms === 0, `창 안 신호는 오탐 아님 (실제 ${timedEval.falseAlarms})`);

  // 창 안에서 여러 번 떠도 전부 '맞은 신호'로 센다.
  //
  // 예전에는 사이클마다 하나만 세서, 창 안에서 세 번 떠도 두 번이 오탐이 됐다.
  // 그래서 자주 뜨는 지표는 정확도가 구조적으로 깎이고 우연일 확률이 100%에 붙었다.
  const many: (boolean | null)[] = bars.map(() => false);
  for (const i of [110, 130, 150, 170]) {
    many[i] = true;
    many[i + 1] = true;
  }
  const manyEval = evaluateSignal(
    bars,
    { ...alwaysOn, key: "many", label: "창 안 다중 점등", state: many },
    cycles,
    baseline,
    share,
  );
  assert(manyEval.eventCount === 4, `신호 4회 (실제 ${manyEval.eventCount})`);
  assert(
    manyEval.inWindowEvents.length === 4,
    `창 안 신호 4회를 전부 센다 (실제 ${manyEval.inWindowEvents.length})`,
  );
  assert(manyEval.falseAlarms === 0, `창 안 다중 점등은 오탐 0 (실제 ${manyEval.falseAlarms})`);
  assert(manyEval.precision === 100, `정확도 100% (실제 ${manyEval.precision})`);
  assert(manyEval.hitCount === 1, `사이클 적중은 여전히 사이클 단위 (실제 ${manyEval.hitCount})`);

  // 창을 다 피해 다니는 지표는 우연일 확률이 높아야 한다.
  // 창은 [80,175]와 [230,399]. 그 사이 빈 구간에서만 뜨게 한다.
  const outside: (boolean | null)[] = bars.map(() => false);
  for (const i of [10, 30, 50, 190, 200, 210]) {
    outside[i] = true;
    outside[i + 1] = true;
  }
  const outsideEval = evaluateSignal(
    bars,
    { ...alwaysOn, key: "outside", label: "창 밖 점등", state: outside },
    cycles,
    baseline,
    share,
  );
  assert(outsideEval.precision === 0, `창 밖만 뜨면 정확도 0% (실제 ${outsideEval.precision})`);
  assert(
    outsideEval.chance != null && outsideEval.chance > 0.5,
    `창 밖 지표는 우연일 확률이 높다 (실제 ${outsideEval.chance})`,
  );
  assert(
    manyEval.chance != null && manyEval.chance < outsideEval.chance!,
    `창 안 지표가 더 우연 같지 않다 (${manyEval.chance} < ${outsideEval.chance})`,
  );

  // 순환 이동 검정. 창이 전체의 10%뿐인 마스크로 따로 본다
  // (위 합성 사이클은 창이 전체의 67%라 무엇을 찍어도 잘 맞는다).
  const mask = windowMask(
    [
      { lo: 100, hi: 150 },
      { lo: 500, hi: 550 },
    ],
    1000,
  );
  const clustered = circularShiftP([100, 110, 120, 130], mask);
  const spread = circularShiftP([0, 250, 500, 750], mask);
  assert(
    clustered != null && clustered < 0.1,
    `창 안에만 네 번 뜨면 우연일 확률이 낮다 (실제 ${clustered})`,
  );
  assert(
    spread != null && clustered != null && clustered < spread,
    `흩어진 신호보다 우연 같지 않다 (${clustered} < ${spread})`,
  );
  assert(circularShiftP([], mask) === null, "신호가 없으면 확률을 못 잰다");
  const one = circularShiftP([110], mask);
  assert(
    one != null && Math.abs(one - 102 / 1000) < 0.01,
    `신호 1회짜리 확률은 창 비율(10.2%)에 수렴 (실제 ${one})`,
  );
}

// ── 12. 매수 등급 · 다중검정 보정 · 조합 ──────────────────────────
console.log("\n[12] 매수 등급 / q값 / 조합");
{
  // BH 보정: 손으로 계산해서 대조.
  const q = fdrQValues([0.01, 0.02, 0.5, null]);
  approx(q[0], Math.min(0.01 * 3, 0.02 * 3 / 2, 0.5), 1e-12, "q(0.01) = min(0.03, 0.03, 0.5)");
  approx(q[1], Math.min(0.02 * 3 / 2, 0.5), 1e-12, "q(0.02) = 0.03");
  approx(q[2], 0.5, 1e-12, "q(0.5) = 0.5");
  assert(q[3] === null, "p를 못 잰 지표는 q도 없다");
  const mono = fdrQValues([0.001, 0.9, 0.02]);
  assert(
    mono[0]! <= mono[2]! && mono[2]! <= mono[1]!,
    `q값은 p 순서를 뒤집지 않는다 (${mono.map((v) => v?.toFixed(3)).join(", ")})`,
  );
  assert(
    fdrQValues([0.04]).every((v) => v != null && v >= 0.04),
    "q값은 항상 p값 이상",
  );

  // AND 상태: 한쪽이 null이면 결과도 null.
  const a: (boolean | null)[] = [null, true, true, false, true];
  const b: (boolean | null)[] = [true, null, true, true, false];
  const and = andState(a, b);
  assert(and[0] === null && and[1] === null, "한쪽이라도 값이 없으면 조합도 값 없음");
  assert(and[2] === true && and[3] === false && and[4] === false, "둘 다 켜져야 켜짐");

  // 실제 파이프라인에서 나온 조합이 정말 두 지표의 AND인지.
  const closes: number[] = [100];
  const ramp = (to: number, days: number) => {
    const from = closes[closes.length - 1];
    for (let i = 1; i <= days; i++) {
      closes.push(from * Math.pow(to / from, i / days) * (1 + Math.sin(i * 1.7) * 0.02));
    }
  };
  ramp(1200, 400);
  ramp(200, 300);
  ramp(2500, 500);
  ramp(700, 350);
  ramp(6000, 600);
  const bars = enrich(barsFromCloses(closes));
  const report = analyzeCycle("BTC-USD", bars);
  const sigs = buildSignals(bars);

  assert(report.combos.length > 0, `조합이 만들어진다 (실제 ${report.combos.length}개)`);
  let andOk = true;
  let groupOk = true;
  for (const c of report.combos) {
    const a = sigs.find((x) => x.key === c.members[0]);
    const b = sigs.find((x) => x.key === c.members[1]);
    if (!a || !b) {
      andOk = false;
      continue;
    }
    if (a.group === b.group) groupOk = false;
    if (eventIndices(andState(a.state, b.state)).length !== c.eventCount) andOk = false;
  }
  assert(andOk, "조합의 신호 횟수 = 두 지표 AND의 신호 횟수");
  assert(groupOk, "같은 성격끼리는 조합하지 않는다");
  assert(
    report.combos.every((c) => c.label.includes(" + ")),
    "조합 이름에 구성 지표가 둘 다 들어간다",
  );
  assert(
    report.signals.every((s) => s.qValue == null || s.chance == null || s.qValue >= s.chance),
    "보정 후 q값은 원래 p값보다 작지 않다",
  );
  assert(
    report.signals.every((s) => (s.grade === "A") === (s.passCount === 6)),
    "A등급 = 여섯 관문 전부 통과",
  );
  assert(
    report.signals.every((s) => s.checks.length === 6),
    "모든 지표에 관문 6개가 채점되어 있다",
  );
  // 조합을 차트에서 고를 수 있어야 한다 = 그림이 나와야 한다.
  const noPlot: string[] = [];
  const noRule: string[] = [];
  for (const c of report.combos) {
    const plot = plotForSignal(c.key, bars);
    const lines = [...plot.overlays, ...(plot.panes ?? (plot.pane ? [plot.pane] : [])).flatMap((p) => p.lines)];
    if (!lines.some((l) => l.data.length)) noPlot.push(c.key);
    if (!plot.rule) noRule.push(c.key);
  }
  assert(noPlot.length === 0, `모든 조합에 그릴 선이 있다 (빈 것: ${noPlot.join(", ") || "없음"})`);
  assert(noRule.length === 0, `모든 조합에 켜짐 조건 설명이 있다 (빠짐: ${noRule.join(", ") || "없음"})`);
  const twoPane = report.combos.find((c) => {
    const p = plotForSignal(c.key, bars);
    return (p.panes ?? []).length === 2;
  });
  assert(
    twoPane == null ||
      plotForSignal(twoPane.key, bars).panes!.every((p) => p.lines.some((l) => l.data.length)),
    "패널이 둘인 조합도 양쪽 다 값이 있다",
  );
  // 주봉 화면에서도 조합 그림이 나와야 한다 (지표 하나짜리와 같은 경로).
  const anyCombo = report.combos[0];
  if (anyCombo) {
    const weekly = plotForView(anyCombo.key, bars, "1w");
    const wLines = [...weekly.overlays, ...(weekly.panes ?? []).flatMap((p) => p.lines)];
    assert(wLines.some((l) => l.data.length), "주봉 화면에서도 조합 그림이 나온다");
  }

  const rsiM = report.signals.find((s) => s.key === "rsi_m50");
  assert(rsiM != null, "월봉 RSI 50 지표가 배터리에 있다");
  assert(rsiM?.timeframe === "월봉", "월봉 RSI는 월봉 지표");
  assert(
    report.signals.every((s) => s.walkForward == null || s.walkForward.early.to < s.walkForward.late.from),
    "앞뒤 기간이 겹치지 않는다",
  );
  assert(
    report.signals.every((s) => s.drawdown.worstPct == null || s.drawdown.worstPct <= 0),
    "낙폭은 0 이하",
  );
}

// ── 13. 랜덤워크에서는 매수 등급이 나오면 안 된다 ──────────────────
//
// 이 앱에서 제일 무서운 실패는 "아무 정보도 없는 시세인데 A등급이 나오는" 것이다.
// 그러면 등급은 도장 찍어주는 기계일 뿐이다. 정보가 없는 시계열로 그걸 확인한다.
console.log("\n[13] 랜덤워크 대조군 (아무 신호도 A가 되면 안 된다)");
{
  const mulberry = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (const seed of [1, 2026]) {
    const rand = mulberry(seed);
    const closes = [1000];
    for (let i = 1; i < 3000; i++) {
      const z = rand() + rand() + rand() + rand() + rand() + rand() - 3;
      closes.push(Math.max(1, closes[i - 1] * Math.exp(0.0006 + 0.04 * z)));
    }
    const bars = enrich(barsFromCloses(closes));
    const report = analyzeCycle("BTC-USD", bars);
    const aGrade = [...report.signals, ...report.combos].filter((s) => s.grade === "A");
    assert(
      aGrade.length === 0,
      `seed ${seed}: 랜덤워크에 A등급 없음 (실제 ${aGrade.length}개: ${aGrade.map((s) => s.label).join(", ")})`,
    );
    const q = [...report.signals, ...report.combos].filter((s) => s.qValue != null && s.qValue < 0.1);
    assert(q.length <= 2, `seed ${seed}: 보정 후 유의한 게 거의 없다 (실제 ${q.length}개)`);
  }
}

// ── 14. 실데이터 (인자로 티커를 주면) ─────────────────────────────
const ticker = process.argv[2];
if (ticker) {
  console.log(`\n[14] 실데이터: ${ticker}`);
  (async () => {
    const { loadBars, MAX_YEARS } = await import("../lib/data");
    const { normalizeTicker } = await import("../lib/data/provider");
    const t = normalizeTicker(ticker);
    const raw = await loadBars(t, { years: MAX_YEARS });
    const bars = enrich(raw);
    const report = analyzeCycle(t, bars);

    console.log(`  기간 ${report.periodStart} ~ ${report.periodEnd} (${report.totalBars}일, ${report.years.toFixed(1)}년)`);
    console.log(`  기준 -${report.thresholds.bearPct}% / +${report.thresholds.bullPct}%`);
    console.log(`  현재 국면: ${report.regime.phase} (${report.regime.since}부터)`);
    console.log(`  상승장 시작: ${report.cycles.map((c) => `${c.troughDate}(${c.drawdownPct?.toFixed(0) ?? "?"}% → +${c.gainPct.toFixed(0)}%)`).join(", ")}`);
    console.log(`  지금 켜진 지표: ${report.now.on}/${report.now.total}`);
    console.log(`  과거 시작 30일 뒤: ${report.cycleStarts.map((c) => `${c.on}/${c.total}`).join(", ")}`);
    console.log(`  기저율 1년: ${report.baseline["250"].avg?.toFixed(1)}%`);
    console.log("\n  --- 상위 10개 ---");
    for (const s of report.signals.slice(0, 10)) {
      console.log(
        `  ${s.label.padEnd(22)} 적중 ${s.hitCount}/${report.cycles.length}` +
          ` 리드 ${String(s.medianLeadDays ?? "—").padStart(4)}일` +
          ` 남은상승 ${(s.medianCaptureSharePct?.toFixed(0) ?? "—").padStart(3)}%` +
          ` 정확도 ${(s.precision?.toFixed(0) ?? "—").padStart(3)}%` +
          ` 신호 ${String(s.eventCount).padStart(3)}회` +
          ` 우연 ${(s.chance == null ? "—" : (s.chance * 100).toFixed(1)).padStart(5)}%` +
          ` 1년 ${(s.forward["250"].avg?.toFixed(0) ?? "—").padStart(5)}%` +
          ` 기저대비 ${(s.edge?.toFixed(0) ?? "—").padStart(5)}%p` +
          ` ${s.currentlyOn ? "🟢" : "⚪"}`,
      );
    }
    console.log(`\n  ${narrate(report)}`);
    console.log(`\n${failures ? `실패 ${failures}건` : "합성 검산 전부 통과"}`);
    process.exit(failures ? 1 : 0);
  })().catch((e) => {
    console.error(`  실데이터 실패: ${(e as Error).message}`);
    process.exit(failures ? 1 : 0);
  });
} else {
  console.log(`\n${failures ? `실패 ${failures}건` : "전부 통과"}`);
  process.exit(failures ? 1 : 0);
}
