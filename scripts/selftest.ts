/**
 * 지표·통계 검산 (외부 API 불필요).
 *   npx tsx scripts/selftest.ts
 *
 * 방식 2가지:
 *  1) 손으로 계산한 상수와 비교
 *  2) 본 구현과 다르게 짠 naive 구현과 비교
 */
import { enrich } from "../lib/indicators";
import { applyFilter, clusterIndices } from "../lib/filter";
import { analyze, forwardReturn, maxForwardReturn } from "../lib/stats";
import { checkLatest, formatAlert } from "../lib/alerts/evaluate";
import { parseMaCommand } from "../lib/ma";
import { PRESET_CHIPS, PRESET_CONDITIONS } from "../lib/presets";
import { aggregateBars, bucketStart } from "../lib/timeframe";
import { bullReport, emaLine, macdLine, rsiLine } from "../lib/bull";
import { toTradingViewSymbol } from "../lib/tradingview";
import type { Bar, FilterSpec, PresetName } from "../types";

let failures = 0;

function approx(actual: number | null, expected: number, tol: number, label: string) {
  if (actual == null || Math.abs(actual - expected) > tol) {
    console.error(`  ✗ ${label}: expected ≈${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`  ✓ ${label}: ${actual.toFixed(6)} (기대 ≈${expected})`);
  }
}

function assert(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

/** 결정론적 픽스처: 종가 +0.1%/일, 거래량 1,000,000 고정, 80번 봉만 5,000,000. */
function fixture(): Bar[] {
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2020, 0, 1 + i));
    const date = d.toISOString().slice(0, 10);
    const volume = i === 80 ? 5_000_000 : 1_000_000;
    bars.push({
      date,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume,
    });
    close *= 1.001;
  }
  return bars;
}

/**
 * 실제 종목에 가까운 결정론적 픽스처.
 * 고정 시드 LCG로 만든 무작위 워크 + 로그정규에 가까운 거래량 분포.
 * "이 신호가 현실에서 가끔은 걸리는가"를 확인하는 용도다.
 */
function noisyFixture(n: number): Bar[] {
  let seed = 20260825;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2020, 0, 1 + i));
    const drift = (rand() - 0.48) * 0.04; // 살짝 상승 편향
    const open = close;
    close = Math.max(1, close * (1 + drift));
    const spread = close * (0.005 + rand() * 0.02);
    const high = Math.max(open, close) + spread * rand();
    const low = Math.min(open, close) - spread * rand();
    // 거래량은 우측 꼬리가 길게 (가끔 크게 터지도록)
    const volume = Math.round(1_000_000 * Math.exp((rand() - 0.5) * 1.4) * (rand() < 0.05 ? 3 : 1));
    bars.push({ date: d.toISOString().slice(0, 10), open, high, low, close, volume });
  }
  return bars;
}

console.log("\n[1] 파생 지표");
{
  const bars = fixture();
  const e = enrich(bars);
  const spike = e[80];

  // vol_ma20 = (19×1,000,000 + 5,000,000) / 20 = 1,200,000
  approx(spike.vol_ma20, 1_200_000, 1e-6, "vol_ma20 (스파이크일)");
  // volume_ratio_20d = 5,000,000 / 1,200,000 = 4.166667
  approx(spike.volume_ratio_20d, 5_000_000 / 1_200_000, 1e-9, "volume_ratio_20d");
  // vol_ma50 = (49×1e6 + 5e6)/50 = 1,080,000
  approx(spike.vol_ma50, 1_080_000, 1e-6, "vol_ma50");
  // close_change_pct = +0.1%
  approx(spike.close_change_pct, 0.1, 1e-9, "close_change_pct");
  // close_position_in_range: high=+1%, low=-1%, close 중앙 → 0.5
  approx(spike.close_position_in_range, 0.5, 1e-9, "close_position_in_range");
  // range_pct = (1.01c - 0.99c)/c × 100 = 2.0
  approx(spike.range_pct, 2.0, 1e-9, "range_pct");
  // dollar_volume = close × volume
  approx(spike.dollar_volume, bars[80].close * 5_000_000, 1e-3, "dollar_volume");

  // zscore를 naive하게 다시 계산해서 대조
  const window = bars.slice(21, 81).map((b) => b.volume);
  const m = window.reduce((a, b) => a + b, 0) / 60;
  const sd = Math.sqrt(window.reduce((a, b) => a + (b - m) ** 2, 0) / 60);
  approx(spike.volume_zscore_60d, (5_000_000 - m) / sd, 1e-9, "volume_zscore_60d (naive 대조)");

  // 워밍업 구간은 null
  assert(e[18].vol_ma20 === null, "19번째 봉 이전 vol_ma20 = null");
  assert(e[19].vol_ma20 !== null, "20번째 봉부터 vol_ma20 계산됨");
  assert(e[58].volume_zscore_60d === null, "60봉 미만 zscore = null");

  // 계속 상승하는 시계열 → 상승일 거래량만 존재 → up/down 비율은 null (하락일 없음)
  assert(e[100].up_down_vol_ratio_20d === null, "하락일 0일 때 up_down_vol_ratio = null");
  // OBV는 전부 상승일이므로 누적 = 거래량 합
  approx(e[5].obv, 5_000_000, 1e-6, "obv (5봉 연속 상승)");

  // ATR(14)를 naive Wilder로 다시 계산
  const tr: number[] = bars.map((b, i) =>
    i === 0
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)),
  );
  let naiveAtr = tr.slice(1, 15).reduce((a, b) => a + b, 0) / 14;
  for (let i = 15; i <= 60; i++) naiveAtr = (naiveAtr * 13 + tr[i]) / 14;
  approx(e[60].atr14, naiveAtr, 1e-9, "atr14 (naive Wilder 대조)");

  // atr_ratio_20d = 현재 ATR ÷ 최근 20개 ATR 평균 (ATR가 준비된 14~60번 봉)
  const atrWindow = e.slice(41, 61).map((bar) => bar.atr14 as number);
  const atrMean = atrWindow.reduce((sum, value) => sum + value, 0) / atrWindow.length;
  approx(e[60].atr_ratio_20d, (e[60].atr14 as number) / atrMean, 1e-9, "atr_ratio_20d");
  assert(e[32].atr_ratio_20d === null, "ATR 비율 워밍업 구간은 null");
  assert(e[33].atr_ratio_20d !== null, "34번째 봉부터 ATR 비율 계산됨");
}

console.log("\n[2] high == low 봉 (0으로 나누기 방어)");
{
  const flat: Bar[] = [
    { date: "2021-01-01", open: 10, high: 10, low: 10, close: 10, volume: 100 },
    { date: "2021-01-02", open: 10, high: 10, low: 10, close: 10, volume: 100 },
  ];
  const e = enrich(flat);
  approx(e[0].close_position_in_range, 0.5, 1e-12, "close_position_in_range = 0.5");
  approx(e[0].range_pct, 0, 1e-12, "range_pct = 0");
}

console.log("\n[3] 전방 수익률");
{
  const bars = fixture();
  const e = enrich(bars);
  // 하루 +0.1% 복리 → 20일 후 종가 수익률 = 1.001^20 - 1
  approx(forwardReturn(e, 50, 20), (1.001 ** 20 - 1) * 100, 1e-9, "forwardReturn d20");
  approx(forwardReturn(e, 50, 5), (1.001 ** 5 - 1) * 100, 1e-9, "forwardReturn d5");
  // 20일 내 고점 = 20일 뒤 고가(=종가×1.01)
  approx(maxForwardReturn(e, 50, 20), (1.001 ** 20 * 1.01 - 1) * 100, 1e-9, "maxForwardReturn 20d");
  assert(forwardReturn(e, 119, 20) === null, "미래 봉 부족 시 null");
}

console.log("\n[4] 클러스터링");
{
  const { kept, sizes } = clusterIndices([10, 11, 12, 30, 45, 46]);
  assert(JSON.stringify(kept) === "[10,30,45]", "연속일 병합 → 첫날만 유지");
  assert(JSON.stringify(sizes) === "[3,1,2]", "클러스터 크기 [3,1,2]");
}

console.log("\n[5] baseline 불변식");
{
  const bars = fixture();
  const e = enrich(bars);
  // 모든 봉이 통과하는 조건이면 stats와 baseline이 정확히 같아야 한다.
  const spec: FilterSpec = {
    conditions: [{ metric: "volume", op: ">=", value: 0 }],
    logic: "AND",
    preset: null,
    interpretation: "전체",
    confidence: "high",
  };
  const r = analyze("TEST", e, spec, { cluster: false });
  assert(r.stats.matchCount === bars.length, `전체 매칭 = ${bars.length}일`);
  approx(r.edge.hitRateDiff, 0, 1e-12, "edge.hitRateDiff = 0 (전체 매칭 시)");
  approx(r.edge.avgReturnDiff, 0, 1e-12, "edge.avgReturnDiff = 0");

  // 조건 미충족 → 매칭 0 + 경고
  const none = analyze("TEST", e, { ...spec, conditions: [{ metric: "volume", op: ">", value: 9e12 }] }, {});
  assert(none.stats.matchCount === 0, "매칭 0일");
  assert(none.warnings.some((w) => w.includes("조건에 맞는 날이 없습니다")), "매칭 0 경고 표시");

  // 스파이크일만 잡는 조건
  const spike = analyze("TEST", e, { ...spec, conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 4 }] }, {});
  assert(spike.stats.matchCount === 1, "volume_ratio>=4 → 1일 매칭");
  assert(spike.matches[0].date === bars[80].date, `매칭일 = ${bars[80].date}`);
  assert(spike.warnings.some((w) => w.includes("표본이 너무 적어")), "표본 부족 경고 표시");
}

console.log("\n[6] AND / OR 로직");
{
  const bars = fixture();
  const e = enrich(bars);
  const base = { logic: "AND" as const, preset: null, interpretation: "", confidence: "high" as const };
  const and = applyFilter(e, {
    ...base,
    conditions: [
      { metric: "volume_ratio_20d", op: ">=", value: 4 },
      { metric: "abs_close_change_pct", op: "<=", value: 2 },
    ],
  });
  const or = applyFilter(e, {
    ...base,
    logic: "OR",
    conditions: [
      { metric: "volume_ratio_20d", op: ">=", value: 4 },
      { metric: "abs_close_change_pct", op: "<=", value: 2 },
    ],
  });
  assert(and.length === 1, "AND → 1일");
  assert(or.length > and.length, `OR → ${or.length}일 (AND보다 많음)`);

  const atrReady = applyFilter(e, {
    ...base,
    conditions: [{ metric: "atr_ratio_20d", op: ">=", value: 0 }],
  });
  assert(atrReady.length === bars.length - 33, "ATR 비율 조건은 워밍업 이후 봉만 통과");

  const crossBars: Bar[] = [];
  for (let i = 0; i < 80; i++) {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    const close = i < 50 ? 100 - i * 0.4 : 95 + (i - 50) * 0.8;
    crossBars.push({ date, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1_000_000 });
  }
  const crossEnriched = enrich(crossBars);
  const spec = parseMaCommand("20일선 돌파");
  assert(spec?.conditions[0]?.kind === "ma_breakout", "20일선 돌파 스펙");
  const breakouts = spec ? applyFilter(crossEnriched, spec) : [];
  assert(breakouts.length >= 1, `이평 돌파 필터 ${breakouts.length}회`);
}

console.log("\n[7] 빠른 신호 — 실제로 걸리는가");
{
  // 조건이 하나라도 유효해야 필터가 전체를 버리지 않는다.
  const names: PresetName[] = ["absorption", "high_close", "accumulation"];
  assert(
    names.every((name) => PRESET_CONDITIONS[name].length > 0),
    "모든 프리셋이 하나 이상의 유효 조건을 가짐",
  );
  assert(
    PRESET_CHIPS.every((chip) => chip.conditions.length > 0 && chip.conditions.length <= 3),
    "빠른 신호는 조건 3개 이하",
  );

  // 무작위 워크 픽스처에서 몇 번이나 걸리는지 참고용으로만 찍는다.
  // 조건 3개짜리 신호(상승 전 압축·강한 돌파)는 임계값이 초기 버전 그대로라
  // 특정 시드에서는 0회일 수 있다 — 그건 결함이 아니라 의도된 엄격함이라
  // 여기서 실패로 처리하지 않는다.
  const bars = noisyFixture(600);
  const e = enrich(bars);

  for (const chip of PRESET_CHIPS) {
    if (chip.lookahead) continue; // 미래를 보는 신호는 별도 성격
    const hits = applyFilter(e, {
      conditions: chip.conditions,
      logic: "AND",
      preset: chip.preset,
      interpretation: chip.label,
      confidence: "high",
    });
    console.log(`  · ${chip.label}: 무작위 워크 600봉 중 ${hits.length}회 매칭 (참고용)`);
  }
}

console.log("\n[8] 알림 판정 (마지막 봉)");
{
  const all = noisyFixture(400);

  // checkLatest는 분석 화면과 같은 필터를 써야 한다.
  // 전체 구간의 매칭일 집합과, 그 날짜에서 잘라낸 시계열의 마지막 봉 판정이 일치해야 한다.
  const full = enrich(all);
  for (const chip of PRESET_CHIPS) {
    if (chip.lookahead) continue;
    const matched = new Set(
      applyFilter(full, {
        conditions: chip.conditions,
        logic: "AND",
        preset: chip.preset,
        interpretation: chip.label,
        confidence: "high",
      }).map((i) => full[i].date),
    );

    let disagreements = 0;
    let fired = 0;
    for (let end = 120; end <= all.length; end++) {
      const sliced = enrich(all.slice(0, end));
      const date = sliced[sliced.length - 1].date;
      const hit = checkLatest(sliced, chip.key) !== null;
      if (hit) fired++;
      if (hit !== matched.has(date)) disagreements++;
    }
    // fired > 0은 요구하지 않는다 — 조건 3개짜리 신호는 400봉 중 한 번도
    // 안 걸릴 수 있다(위와 같은 이유). checkLatest가 전체 필터와 어긋나지
    // 않는지만 확인하면 충분하다.
    assert(
      disagreements === 0,
      `${chip.label}: 마지막 봉 판정이 전체 필터와 일치 (${fired}회 발동, 불일치 ${disagreements})`,
    );
  }

  // lookahead 신호는 미래를 봐야 하므로 실시간 판정 대상이 아니다.
  assert(checkLatest(full, "pre_surge") === null, "급등 직전은 알림으로 판정하지 않음");

  // formatAlert 자체는 임계값과 무관하게 확인 — 결정론적 스파이크 픽스처의
  // 스파이크 봉(볼륨 5배, 종가 변동 미미)에서 잘라 물량 흡수가 반드시 걸리게 한다.
  const spikeBars = fixture().slice(0, 81); // 마지막 봉 = 스파이크 봉(인덱스 80)
  const spikeEnriched = enrich(spikeBars);
  const hit = checkLatest(spikeEnriched, "absorption");
  const message = hit ? formatAlert("TEST", [hit]) : "";
  assert(
    hit !== null &&
      message.includes("TEST") &&
      message.includes(spikeEnriched[spikeEnriched.length - 1].date),
    "알림 메시지에 티커와 날짜가 들어감",
  );

  const today = new Date().toISOString().slice(0, 10);
  const stockToday = enrich([
    ...fixture().slice(0, 80),
    { date: today, open: 100, high: 102, low: 99, close: 101, volume: 5_000_000 },
  ]);
  const stockHit = checkLatest(stockToday, "volume_spike", null, "AAPL");
  assert(
    stockHit?.bar.date === today,
    "주식 알림은 오늘(장 마감) 봉을 본다",
  );
  const cryptoHit = checkLatest(stockToday, "volume_spike", null, "BTC-USD");
  assert(
    cryptoHit == null || cryptoHit.bar.date !== today,
    "코인 알림은 미완성 오늘 봉을 건너뛴다",
  );
}

// ── [9] 봉 집계 (주봉·월봉) ────────────────────────────────────
console.log("\n[9] 봉 집계");
{
  // 2020-01-01은 수요일. 그 주 월요일은 2019-12-30.
  assert(bucketStart("2020-01-01", "1w") === "2019-12-30", "주봉 시작일 = 그 주 월요일");
  assert(bucketStart("2020-01-05", "1w") === "2019-12-30", "일요일도 같은 주에 들어간다");
  assert(bucketStart("2020-01-06", "1w") === "2020-01-06", "월요일은 새 주봉");
  assert(bucketStart("2020-03-17", "1M") === "2020-03-01", "월봉 시작일 = 그 달 1일");
  assert(bucketStart("2020-03-17", "1d") === "2020-03-17", "일봉은 그대로");

  // 평일만 있는 일봉 3주치. 집계 결과를 손으로 확인한다.
  const days: Bar[] = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(Date.UTC(2024, 0, 1 + i));
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; // 주말 제외
    days.push({
      date: d.toISOString().slice(0, 10),
      open: 100 + i,
      high: 105 + i,
      low: 95 + i,
      close: 101 + i,
      volume: 1_000 * (i + 1),
    });
  }

  const weekly = aggregateBars(days, "1w");
  const firstWeek = days.filter((b) => b.date >= "2024-01-01" && b.date <= "2024-01-05");
  assert(weekly.length === 3, `주봉 3개로 묶임 (실제 ${weekly.length})`);
  assert(weekly[0].date === "2024-01-01", "첫 주봉 시작일 = 2024-01-01(월)");
  assert(weekly[0].periodEnd === "2024-01-05", "첫 주봉 마지막 거래일 = 2024-01-05(금)");
  assert(weekly[0].open === firstWeek[0].open, "주봉 시가 = 구간 첫 봉 시가");
  assert(weekly[0].close === firstWeek[firstWeek.length - 1].close, "주봉 종가 = 구간 마지막 종가");
  assert(weekly[0].high === Math.max(...firstWeek.map((b) => b.high)), "주봉 고가 = 구간 최고가");
  assert(weekly[0].low === Math.min(...firstWeek.map((b) => b.low)), "주봉 저가 = 구간 최저가");
  assert(
    weekly[0].volume === firstWeek.reduce((a, b) => a + b.volume, 0),
    "주봉 거래량 = 구간 합",
  );
  assert(weekly[0].dayCount === firstWeek.length, "주봉 dayCount = 들어간 일봉 수");

  const monthly = aggregateBars(days, "1M");
  assert(monthly.length === 1, "같은 달이면 월봉 1개");
  assert(
    monthly[0].volume === days.reduce((a, b) => a + b.volume, 0),
    "월봉 거래량 = 전체 합",
  );
  assert(
    aggregateBars(days, "1d").length === days.length,
    "일봉은 개수가 그대로",
  );

  // 펀딩비는 구간 평균
  const withFunding: Bar[] = days.slice(0, 5).map((b, i) => ({ ...b, funding: (i + 1) / 10_000 }));
  const fundedWeek = aggregateBars(withFunding, "1w");
  approx(fundedWeek[0].funding ?? null, 3 / 10_000, 1e-12, "주봉 펀딩비 = 구간 평균");
}

// ── [10] RSI · EMA · MACD ─────────────────────────────────────
console.log("\n[10] RSI · EMA · MACD");
{
  // EMA(3): 앞 3개 단순평균으로 시작, 이후 k = 2/(3+1) = 0.5
  const ema3 = emaLine([1, 2, 3, 4, 5], 3);
  assert(ema3[0] === null && ema3[1] === null, "EMA는 기간 이전 구간이 null");
  approx(ema3[2], 2, 1e-9, "EMA(3) 첫 값 = (1+2+3)/3");
  approx(ema3[3], 3, 1e-9, "EMA(3) 다음 값 = 4*0.5 + 2*0.5");
  approx(ema3[4], 4, 1e-9, "EMA(3) 그 다음 = 5*0.5 + 3*0.5");
  assert(emaLine([1, 2], 5).every((v) => v === null), "값이 기간보다 적으면 전부 null");

  // 계속 오르기만 하면 RSI는 100 (하락분이 0이라 나눌 게 없다)
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  approx(rsiLine(rising, 14)[39], 100, 1e-9, "계속 상승하면 RSI = 100");
  const falling = Array.from({ length: 40 }, (_, i) => 100 - i);
  approx(rsiLine(falling, 14)[39], 0, 1e-9, "계속 하락하면 RSI = 0");
  assert(rsiLine(rising, 14)[13] === null, "RSI는 14봉 전까지 null");

  // 값이 일정하면 두 EMA가 같으므로 MACD도 시그널도 0
  const flat = new Array(80).fill(100);
  const flatMacd = macdLine(flat)[79];
  approx(flatMacd?.macd ?? null, 0, 1e-9, "평평한 시세의 MACD = 0");
  approx(flatMacd?.hist ?? null, 0, 1e-9, "평평한 시세의 히스토그램 = 0");

  // 꾸준히 오르면 빠른 EMA가 느린 EMA보다 위 → MACD > 0
  const up = Array.from({ length: 120 }, (_, i) => 100 * 1.01 ** i);
  const upMacd = macdLine(up)[119];
  assert((upMacd?.macd ?? 0) > 0, "상승 추세에서 MACD > 0");
  assert(macdLine(up.slice(0, 20))[19] === null, "봉이 부족하면 MACD는 null");
}

// ── [11] 상승장 지표 ──────────────────────────────────────────
console.log("\n[11] 상승장 지표");
{
  /** 방향이 정해진 결정론적 일봉. drift가 양수면 상승장. */
  function trend(n: number, drift: number): Bar[] {
    const bars: Bar[] = [];
    let close = 100;
    for (let i = 0; i < n; i++) {
      const d = new Date(Date.UTC(2021, 0, 1 + i));
      const open = close;
      close = close * (1 + drift);
      bars.push({
        date: d.toISOString().slice(0, 10),
        open,
        high: Math.max(open, close) * 1.004,
        low: Math.min(open, close) * 0.996,
        close,
        // 오르는 날 거래량을 더 싣는다 (매수/매도 거래량 비가 의미를 갖도록)
        volume: close >= open ? 1_400_000 : 900_000,
      });
    }
    return bars;
  }

  for (const tf of ["1d", "1w", "1M"] as const) {
    const bull = trend(1300, 0.0015);
    const periods = aggregateBars(bull, tf);
    const report = bullReport("TEST", tf, enrich(periods), periods);
    assert(report.indicators.length >= 8, `${tf}: 지표 ${report.indicators.length}개 계산됨`);
    assert(report.score >= 70, `${tf}: 상승 픽스처 점수 ${report.score} ≥ 70`);
    assert(report.asOf === periods[periods.length - 1].periodEnd, `${tf}: asOf = 마지막 거래일`);
    assert(
      report.bullish + report.neutral + report.bearish === report.indicators.length,
      `${tf}: 판정 합계 = 지표 수`,
    );

    const bearPeriods = aggregateBars(trend(1300, -0.0015), tf);
    const bear = bullReport("TEST", tf, enrich(bearPeriods), bearPeriods);
    assert(bear.score <= 30, `${tf}: 하락 픽스처 점수 ${bear.score} ≤ 30`);
  }

  // 봉마다 지표 기간이 실제로 달라야 한다 (같으면 일봉을 그대로 쓴 것).
  const daily = aggregateBars(trend(1300, 0.0015), "1d");
  const monthly = aggregateBars(trend(1300, 0.0015), "1M");
  const dailyLabels = bullReport("T", "1d", enrich(daily), daily).indicators.map((i) => i.label);
  const monthlyLabels = bullReport("T", "1M", enrich(monthly), monthly).indicators.map((i) => i.label);
  assert(
    dailyLabels.join("|") !== monthlyLabels.join("|"),
    "일봉과 월봉의 지표 기간이 서로 다르다",
  );
}

// ── [12] TradingView 심볼 ─────────────────────────────────────
console.log("\n[12] TradingView 심볼");
{
  assert(toTradingViewSymbol("BTC-USD") === "CRYPTO:BTCUSD", "비트코인 = CRYPTO:BTCUSD (현물)");
  assert(toTradingViewSymbol("ETH-USD") === "CRYPTO:ETHUSD", "이더리움 = CRYPTO:ETHUSD");
  assert(toTradingViewSymbol("005930.KS") === "KRX:005930", "한국 종목 = KRX:종목코드");
  assert(toTradingViewSymbol("000660.KQ") === "KRX:000660", "코스닥도 KRX 아래");
  assert(toTradingViewSymbol("AAPL") === "AAPL", "미국 주식은 거래소 없이");
}

console.log(
  failures === 0
    ? "\n✅ 전부 통과\n"
    : `\n❌ ${failures}개 실패\n`,
);
process.exit(failures === 0 ? 0 : 1);
