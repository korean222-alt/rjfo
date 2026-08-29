/**
 * 사이클 분석 검산.
 *   npx tsx scripts/cycle-test.ts            # 합성 데이터 (네트워크 불필요)
 *   npx tsx scripts/cycle-test.ts BTC-USD    # 실데이터로 리포트 출력
 *
 * 합성 파트는 바닥 위치를 미리 아는 시계열을 만들어, 라벨러가 그 바닥을
 * 정확히 찍는지 본다. 라벨링이 틀리면 나머지 통계는 전부 무의미하다.
 */
import { enrich } from "../lib/indicators";
import { analyzeCycle } from "../lib/cycle";
import { findCycles, findPivots } from "../lib/cycle/regime";
import { eventIndices } from "../lib/cycle/evaluate";
import { toMonthly, toWeekly, projectToDaily, barsForView, snapDatesToView } from "../lib/cycle/resample";
import { atr, ema, macd, rsi, sma, supertrend } from "../lib/cycle/ta";
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
    report.signals.every((s) => s.eventCount >= s.hitCount),
    "적중 횟수는 신호 횟수를 넘을 수 없다",
  );
  assert(
    report.signals.every((s) => s.falseAlarms >= 0),
    "오탐 횟수는 음수가 될 수 없다",
  );
  assert(report.now.on <= report.now.total, "켜진 지표 수 ≤ 전체 지표 수");
  assert(report.warnings.length > 0, "경고 문구가 항상 붙는다");
  assert(narrate(report).length > 50, "요약 문장 생성");

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
    last != null && Math.abs(last / lastClose - 1) < 0.5,
    `200일선이 가격과 같은 스케일 (선 ${last?.toFixed(1) ?? "없음"} vs 종가 ${lastClose.toFixed(1)})`,
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

// ── 9. 슈퍼트렌드 · 50주선 ────────────────────────────────────────
console.log("\n[9] 슈퍼트렌드 · 50주선");
{
  // ATR: 고가/저가가 종가 ±0.5%인 합성 봉을 naive Wilder로 다시 계산해 대조한다.
  const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
  const bars = barsFromCloses(closes);
  const a = atr(bars, 10);

  const tr: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  let naive = tr.slice(1, 11).reduce((s, v) => s + v, 0) / 10;
  approx(a[10], naive, 1e-9, "ATR(10) 첫 값 = TR 10개 단순평균");
  for (let i = 11; i <= 40; i++) naive = (naive * 9 + tr[i]) / 10;
  approx(a[40], naive, 1e-9, "ATR(10)[40] (naive Wilder 대조)");
  assert(a[9] == null, "ATR는 10봉이 차기 전에는 null");

  // 첫 반전 전에는 값을 내지 않는다. 단조 상승만 하면 반전이 없으므로 전부 null이어야 한다.
  const rising = supertrend(barsFromCloses(closes));
  assert(
    rising.up.every((v) => v == null),
    "단조 상승: 반전이 없으니 전부 null (시드 추세를 적중으로 세지 않는다)",
  );

  // 내려가다 올라오는 시계열: 하락으로 뒤집힌 뒤 다시 상승으로 뒤집혀야 한다.
  const vShape = [
    ...Array.from({ length: 80 }, (_, i) => 200 - i * 1.5),
    ...Array.from({ length: 120 }, (_, i) => 80 + i * 2),
  ];
  const vBars = barsFromCloses(vShape);
  const st = supertrend(vBars);
  const firstDown = st.up.findIndex((v) => v === false);
  const turnedUp = st.up.findIndex((v, i) => v === true && i > firstDown && firstDown >= 0);
  assert(firstDown > 0, `하락 구간에서 하락으로 뒤집힘 (idx ${firstDown})`);
  assert(turnedUp > firstDown, `반등 뒤 상승으로 다시 뒤집힘 (idx ${turnedUp})`);
  assert(turnedUp > 80 && turnedUp < 120, `전환 시점이 바닥(idx 80) 부근 (idx ${turnedUp})`);

  // 선은 상승 추세면 종가 아래, 하락 추세면 위에 있어야 한다. 반대면 부호가 뒤집힌 것이다.
  const wrongSide = st.up.filter((v, i) => {
    if (v == null || st.line[i] == null) return false;
    return v ? st.line[i]! > vBars[i].close : st.line[i]! < vBars[i].close;
  }).length;
  assert(wrongSide === 0, `슈퍼트렌드 선이 추세와 같은 쪽 (어긋남 ${wrongSide}개)`);

  // 두 지표가 배터리와 차트에 실제로 등록됐는지.
  // [7]과 같은 시계열: 추세 + 진동 + 결정론적 노이즈. 슈퍼트렌드가 실제로 몇 번 뒤집힌다.
  const longCloses: number[] = [100];
  for (let i = 1; i < 1600; i++) {
    longCloses.push(
      longCloses[i - 1] * (1 + 0.0004 + Math.sin(i / 90) * 0.004 + Math.sin(i * 2.3) * 0.006),
    );
  }
  const longBars = enrich(barsFromCloses(longCloses));

  const flips = supertrend(longBars).up.filter(
    (v, i, arr) => v != null && i > 0 && arr[i - 1] != null && arr[i - 1] !== v,
  ).length;
  assert(flips > 2, `1600봉에서 추세가 여러 번 뒤집힌다 (${flips}회)`);
  const keys = buildSignals(longBars).map((s) => s.key);
  assert(keys.includes("supertrend"), "배터리에 슈퍼트렌드 있음");
  assert(keys.includes("w_ma50"), "배터리에 50주선 있음");

  for (const key of ["supertrend", "w_ma50"]) {
    const plot = plotForSignal(key, longBars);
    assert(
      plot.overlays.length > 0 && plot.overlays[0].data.length > 0 && Boolean(plot.rule),
      `${key} 차트 오버레이와 설명 있음`,
    );
  }

  // 슈퍼트렌드는 상승(초록)·하락(빨강) 두 선으로 나눠 그린다. 한 줄로 그리면
  // 뒤집히는 순간의 점프가 긴 사선으로 이어져 없는 추세처럼 보인다.
  const stPlot = plotForSignal("supertrend", longBars);
  assert(stPlot.overlays.length === 2, `슈퍼트렌드는 선 2개 (실제 ${stPlot.overlays.length})`);
  const [upLine, downLine] = stPlot.overlays;
  assert(upLine.color !== downLine.color, "상승·하락 선 색이 다르다");
  assert(
    upLine.data.some((p) => p.value != null) && downLine.data.some((p) => p.value != null),
    "두 선 모두 실제 값이 있다",
  );
  assert(
    upLine.data.some((p) => p.value == null),
    "상승선에 끊긴 구간(null)이 있다 — 하락 구간을 이어 그리지 않는다",
  );

  // 같은 날 두 선이 동시에 값을 가지면 안 된다 (추세는 하나뿐이다).
  const upAt = new Map(upLine.data.map((p) => [p.date, p.value]));
  const both = downLine.data.filter((p) => p.value != null && upAt.get(p.date) != null).length;
  assert(both === 0, `같은 날 두 선이 겹치지 않는다 (겹침 ${both}개)`);

  // 초록은 항상 가격 아래, 빨강은 항상 가격 위.
  const closeAt = new Map(longBars.map((b) => [b.date, b.close]));
  const upWrong = upLine.data.filter((p) => p.value != null && p.value > closeAt.get(p.date)!).length;
  const downWrong = downLine.data.filter((p) => p.value != null && p.value < closeAt.get(p.date)!).length;
  assert(upWrong === 0, `초록선은 가격 아래 (어긋남 ${upWrong}개)`);
  assert(downWrong === 0, `빨강선은 가격 위 (어긋남 ${downWrong}개)`);

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

// ── 10. 실데이터 (인자로 티커를 주면) ─────────────────────────────
const ticker = process.argv[2];
if (ticker) {
  console.log(`\n[10] 실데이터: ${ticker}`);
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
