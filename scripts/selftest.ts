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
import { analyze, forwardReturn, maxForwardReturn, resolveSignalRule } from "../lib/stats";
import { PRESET_CHIPS, PRESET_CONDITIONS, PRESET_SIGNAL_RULES } from "../lib/presets";
import { computeRarity } from "../lib/rarity";
import { detectMaCrosses, movingAverage } from "../lib/ma-cross";
import { validateSpec } from "../lib/validate-spec";
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

console.log("\n[4] 국면 묶기");
{
  // 희귀도가 없으면 첫날을 대표로 (예전 동작)
  const plain = clusterIndices([10, 11, 12, 30, 45, 46]);
  assert(
    JSON.stringify(plain.map((c) => c.index)) === "[10,30,45]",
    "희귀도 없으면 국면 첫날을 대표로",
  );
  assert(JSON.stringify(plain.map((c) => c.size)) === "[3,1,2]", "국면 크기 [3,1,2]");

  // 희귀도를 주면 국면에서 가장 드문 날을 대표로 — 여기가 시간 간격 방식과 갈리는 지점이다.
  const rarity: (number | null)[] = new Array(50).fill(0);
  rarity[10] = 40;
  rarity[11] = 95; // 국면 한가운데가 제일 강한 날
  rarity[12] = 50;
  rarity[45] = 30;
  rarity[46] = 88;
  const picked = clusterIndices([10, 11, 12, 30, 45, 46], 1, rarity);
  assert(
    JSON.stringify(picked.map((c) => c.index)) === "[11,30,46]",
    "국면 대표일 = 가장 희귀한 날 (중요한 날이 잘려나가지 않음)",
  );
  assert(
    JSON.stringify(picked.map((c) => c.start)) === "[10,30,45]" &&
      JSON.stringify(picked.map((c) => c.end)) === "[12,30,46]",
    "대표일과 별개로 국면의 시작·끝을 함께 보고",
  );

  // pick: "first"면 희귀도가 있어도 첫날
  const first = clusterIndices([10, 11, 12], 1, rarity, "first");
  assert(first[0].index === 10, 'pick "first" → 가장 이른 날을 대표로');

  // gap을 넓히면 하루이틀 끊긴 것도 같은 국면
  const wide = clusterIndices([10, 13, 16, 40], 3, rarity);
  assert(wide.length === 2, "gap 3 → 3일 간격으로 이어진 날들을 한 국면으로");
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
}

console.log("\n[7] 빠른 신호 프리셋");
{
  const expected: PresetName[] = [
    "absorption",
    "accumulation",
    "squeeze",
    "high_close",
    "strong_breakout",
    "volume_expansion",
    "flow_improvement",
    "stealth_accumulation",
    "volume_dry_up",
    "base_breakout",
    "pullback_support",
  ];
  assert(
    expected.every((name) => PRESET_CONDITIONS[name].length > 0),
    "모든 빠른 신호가 하나 이상의 유효 조건을 가짐",
  );
  assert(
    expected.every((name) => PRESET_SIGNAL_RULES[name] != null),
    "모든 프리셋에 신호 정리 규칙이 정의됨",
  );
  assert(
    expected.every((name) => PRESET_CHIPS.some((chip) => chip.preset === name)),
    "모든 프리셋이 UI 카드로 노출됨",
  );

  // 손대지 않기로 한 기존 이벤트형 프리셋은 수치가 그대로여야 한다.
  assert(PRESET_CONDITIONS.absorption.length === 2, "기존 물량 흡수는 두 조건을 유지");
  assert(
    PRESET_CONDITIONS.absorption[0].metric === "volume_ratio_20d" &&
      PRESET_CONDITIONS.absorption[0].value === 2 &&
      PRESET_CONDITIONS.absorption[1].metric === "abs_close_change_pct" &&
      PRESET_CONDITIONS.absorption[1].value === 2,
    "기존 물량 흡수 = 20일 평균 거래량 2배 이상 · 종가 변동 ±2% 이내",
  );
  assert(
    PRESET_CONDITIONS.high_close.length === 2 &&
      PRESET_CONDITIONS.high_close[0].value === 1.8 &&
      PRESET_CONDITIONS.high_close[1].value === 0.75,
    "기존 고가 마감 = 거래량 1.8배 이상 · 종가 위치 0.75 이상",
  );
  assert(PRESET_CONDITIONS.strong_breakout.length === 3, "강한 돌파는 거래량·가격·고가권 마감 조건을 사용");
  assert(
    PRESET_CONDITIONS.squeeze.length === 3 && PRESET_CONDITIONS.squeeze[0].value === 0.8,
    "상승 전 압축 조건은 그대로 유지",
  );

  // 누적 매집 — 조건 강화 + 발화 규칙
  const acc = PRESET_CONDITIONS.accumulation;
  assert(acc.length === 4, "누적 매집 = 4개 조건으로 강화");
  assert(
    acc[0].metric === "up_down_vol_ratio_20d" && acc[0].value === 2.0,
    "누적 매집 상승·하락일 거래량 비율 1.5 → 2.0",
  );
  assert(
    acc[1].metric === "obv_slope_20d" && acc[1].value === 0.6,
    "누적 매집 OBV 기울기 0.3 → 0.6",
  );
  assert(
    acc.some((c) => c.metric === "vol_ma_ratio_20_50") &&
      acc.some((c) => c.metric === "close_vs_sma20_pct"),
    "누적 매집에 거래량 베이스·20일선 이격도 조건 추가",
  );
  assert(
    PRESET_SIGNAL_RULES.accumulation.top_pct === 30 &&
      PRESET_SIGNAL_RULES.accumulation.cluster_gap === 5,
    "누적 매집 = 희귀도 상위 30% · 국면 gap 5일",
  );
  assert(
    PRESET_SIGNAL_RULES.stealth_accumulation.top_pct <= 30 &&
      PRESET_SIGNAL_RULES.flow_improvement.top_pct <= 30,
    "상태 지표 기반 프리셋은 순위 컷을 좁게",
  );
  assert(
    PRESET_SIGNAL_RULES.absorption.top_pct === 100 &&
      PRESET_SIGNAL_RULES.strong_breakout.cluster_gap === 1,
    "이벤트 지표 기반 프리셋은 순위 컷 없이 연속일만 묶음",
  );
  assert(
    (Object.keys(PRESET_SIGNAL_RULES) as PresetName[]).every(
      (n) => PRESET_SIGNAL_RULES[n].top_pct >= 1 && PRESET_SIGNAL_RULES[n].top_pct <= 100,
    ),
    "순위 컷은 전부 1~100 범위",
  );
  assert(
    PRESET_CONDITIONS.flow_improvement[0].value === 1.6 &&
      PRESET_CONDITIONS.flow_improvement[1].value === 0.3,
    "수급 개선 = 거래량 비율 1.6 이상 · OBV 기울기 0.3 이상으로 강화",
  );
}

console.log("\n[8] 새 파생 지표");
{
  const bars = fixture();
  const e = enrich(bars);
  const i = 100;

  // close_vs_sma20_pct — naive 대조
  const closeWindow = bars.slice(i - 19, i + 1).map((b) => b.close);
  const sma20 = closeWindow.reduce((a, b) => a + b, 0) / 20;
  approx(
    e[i].close_vs_sma20_pct,
    ((bars[i].close - sma20) / sma20) * 100,
    1e-9,
    "close_vs_sma20_pct (naive 대조)",
  );

  // dist_from_high_60d_pct — 직전 60봉(현재 봉 제외) 최고가 기준
  const high60 = Math.max(...bars.slice(i - 60, i).map((b) => b.high));
  approx(
    e[i].dist_from_high_60d_pct,
    ((bars[i].close - high60) / high60) * 100,
    1e-9,
    "dist_from_high_60d_pct (naive 대조)",
  );
  const low60 = Math.min(...bars.slice(i - 60, i).map((b) => b.low));
  approx(
    e[i].dist_from_low_60d_pct,
    ((bars[i].close - low60) / low60) * 100,
    1e-9,
    "dist_from_low_60d_pct (naive 대조)",
  );

  // 계속 상승하는 픽스처 → 20일 전부 상승일
  approx(e[i].up_day_ratio_20d, 1, 1e-12, "up_day_ratio_20d (전부 상승일)");
  // 스파이크 하루 때문에 20일MA가 50일MA보다 높다
  assert((e[80].vol_ma_ratio_20_50 as number) > 1, "스파이크 직후 vol_ma_ratio_20_50 > 1");
  // 119번 봉에선 20일 창에서 스파이크가 빠졌지만 50일 창엔 아직 남아 있다 → 1 미만
  approx(
    e[119].vol_ma_ratio_20_50,
    1_000_000 / 1_080_000,
    1e-9,
    "스파이크가 50일 창에만 남으면 vol_ma_ratio_20_50 < 1",
  );
  // 고저폭이 매일 같은 비율이라 range_ratio_20d ≈ 1 (종가가 오르니 아주 살짝 크다)
  assert(
    Math.abs((e[i].range_ratio_20d as number) - 1) < 0.02,
    "range_ratio_20d ≈ 1 (고저폭 일정)",
  );

  assert(e[58].dist_from_high_60d_pct === null, "60봉 미만 dist_from_high_60d_pct = null");
  assert(e[60].dist_from_high_60d_pct !== null, "61번째 봉부터 dist_from_high_60d_pct 계산됨");
  assert(e[58].obv_slope_60d === null, "60봉 미만 obv_slope_60d = null");
}

console.log("\n[9] 희귀도");
{
  const bars = fixture();
  const e = enrich(bars);

  // 거래량은 80번 봉만 5배. volume_ratio_20d가 클수록 드문 조건이므로
  // 80번 봉의 희귀도가 최대(100)여야 한다.
  const spec: FilterSpec = {
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 1 }],
    logic: "AND",
    preset: null,
    interpretation: "",
    confidence: "high",
  };
  const rarity = computeRarity(e, spec);
  approx(rarity[80], 100, 1e-9, "가장 거래량이 큰 날의 희귀도 = 100");
  assert(rarity[18] === null, "워밍업 구간 희귀도 = null");
  assert(
    (rarity[80] as number) > (rarity[100] as number),
    "스파이크일이 평범한 날보다 희귀도가 높음",
  );

  // 방향 뒤집기: `<=` 조건이면 값이 작을수록 드물다
  const inverted = computeRarity(e, { ...spec, conditions: [{ metric: "volume_ratio_20d", op: "<=", value: 9 }] });
  assert(
    (inverted[80] as number) < (inverted[100] as number),
    "`<=` 조건에서는 값이 작은 날이 더 희귀",
  );

  // naive 대조 — 전체 분포에서 자기 이하인 값의 비율
  const values = e.map((b) => b.volume_ratio_20d).filter((v): v is number => v != null);
  const target = e[100].volume_ratio_20d as number;
  const naive = (values.filter((v) => v <= target).length / values.length) * 100;
  approx(rarity[100], naive, 1e-9, "희귀도 백분위 (naive 대조)");
}

console.log("\n[10] 희귀도 순위로 신호 줄이기 (시간 간격 없이)");
{
  // 40~79번 봉이 통째로 조건을 만족하는 "국면"을 만들고, 그 한가운데(60번 봉)에
  // 가장 강한 날을 심는다. 이 날이 절대 잘려선 안 되는 날이다.
  //
  // 조건 지표로 volume_ratio_20d 대신 raw volume을 쓴다. 전자는 "그날 값 ÷ 자기 20일 평균"이라
  // 스파이크가 자기 분모를 밀어올려 국면을 스스로 끊어버린다.
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2020, 0, 1 + i));
    let volume = 1_000_000;
    if (i >= 40 && i < 80) volume = 2_000_000 + (i % 10) * 100_000; // 국면 안에서도 편차를 준다
    if (i === 60) volume = 12_000_000; // 국면 한가운데의 가장 강한 날
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume,
    });
    close *= 1.001;
  }
  const e = enrich(bars);
  const base = { logic: "AND" as const, preset: null, interpretation: "", confidence: "high" as const };
  const conditions = [{ metric: "volume" as const, op: ">=" as const, value: 2_000_000 }];
  const spikeDate = bars[60].date;

  const all = applyFilter(e, { ...base, conditions });
  assert(all.length === 40, `정리 규칙 없으면 ${all.length}일 매칭 (국면이 통째로 잡힘)`);

  // 희귀도 순위만으로 신호를 줄인다 — 시간 간격은 쓰지 않는다.
  const strict = analyze("TEST", e, { ...base, conditions, top_pct: 10 }, { cluster: false });
  assert(strict.stats.matchCount === 4, `상위 10% → 40개 중 4개 (실제 ${strict.stats.matchCount})`);
  assert(
    strict.matches.some((m) => m.date === spikeDate),
    "가장 강한 날은 아무리 좁게 잘라도 살아남음",
  );
  assert(strict.rawMatchCount === all.length, "rawMatchCount = 정리 전 조건 충족일");
  assert(strict.rankedOutCount === all.length - strict.stats.matchCount, "순위에서 밀린 신호 수 보고");

  // 아무리 좁혀도 최소 1개는 남는다 (조건이 빡빡한 프리셋이 통째로 0개가 되지 않도록)
  const tiny = analyze("TEST", e, { ...base, conditions, top_pct: 1 }, { cluster: false });
  assert(tiny.stats.matchCount === 1, "상위 1%여도 최소 1개는 남음");
  assert(tiny.matches[0].date === spikeDate, "그 1개는 가장 강한 날");

  // 국면으로 묶어도 대표일은 국면에서 가장 드문 날 = 스파이크일
  const clustered = analyze("TEST", e, { ...base, conditions, cluster_gap: 5 }, {});
  assert(
    clustered.matches.some((m) => m.date === spikeDate),
    "국면으로 묶어도 대표일은 그 국면에서 가장 드문 날",
  );
  assert(clustered.stats.matchCount < all.length, "국면 묶기가 신호 수를 줄임");

  // 대표일을 "first"로 바꾸면 스파이크일 대신 국면 첫날이 남는다 (선택지로만 제공)
  const firstPick = analyze("TEST", e, { ...base, conditions, cluster_gap: 5, cluster_pick: "first" }, {});
  assert(
    firstPick.matches.every((m) => m.date !== spikeDate) &&
      firstPick.matches.some((m) => m.date === bars[40].date),
    'pick "first"는 국면 첫날을 남긴다 — 국면 한가운데의 가장 강한 날이 빠진다 (기본값이 "rarest"인 이유)',
  );

  // 규칙을 끄면 예전 동작 그대로
  const off = analyze("TEST", e, { ...base, conditions, top_pct: 100 }, { cluster: false });
  assert(off.stats.matchCount === all.length, "규칙을 끄면 전체 매칭 (하위 호환)");

  // 희귀도가 결과에 실린다
  assert(
    off.matches.every((m) => m.rarity != null),
    "모든 매칭 행에 희귀도가 실림",
  );
}

console.log("\n[11] 프리셋 기본 규칙 / 스펙 검증");
{
  const spec: FilterSpec = {
    conditions: PRESET_CONDITIONS.accumulation,
    logic: "AND",
    preset: "accumulation",
    interpretation: "",
    confidence: "high",
  };
  const rule = resolveSignalRule(spec);
  assert(rule.topPct === 30 && rule.clusterGap === 5, "프리셋 기본 정리 규칙 적용");
  assert(rule.clusterPick === "rarest", '대표일 기본값 = "rarest"');

  const overridden = resolveSignalRule({ ...spec, top_pct: 50, cluster_gap: 2, cluster_pick: "first" });
  assert(
    overridden.topPct === 50 && overridden.clusterGap === 2 && overridden.clusterPick === "first",
    "명시된 규칙이 프리셋 기본값을 덮어씀",
  );

  const none = resolveSignalRule({ ...spec, preset: null });
  assert(none.topPct === 100 && none.clusterGap === 1, "프리셋 없으면 규칙 없음");

  // validateSpec이 정리 규칙을 통과시키고 범위를 건다
  const v = validateSpec({
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 2 }],
    logic: "AND",
    top_pct: 999,
    cluster_gap: 999,
    cluster_pick: "first",
    interpretation: "테스트",
    confidence: "high",
  });
  assert(v.top_pct === 100, "validateSpec: top_pct 상한 100");
  assert(v.cluster_gap === 20, "validateSpec: cluster_gap 상한 20");
  assert(v.cluster_pick === "first", "validateSpec: cluster_pick 통과");

  const v2 = validateSpec({
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 2 }],
    logic: "AND",
    top_pct: "이상한값",
    cluster_pick: "아무거나",
    interpretation: "테스트",
    confidence: "high",
  });
  assert(v2.top_pct === undefined, "validateSpec: 숫자가 아니면 버리고 프리셋 기본값에 맡김");
  assert(v2.cluster_pick === undefined, "validateSpec: 알 수 없는 cluster_pick은 버림");

  // 새 metric이 실제로 필터에서 동작하는지
  const bars = fixture();
  const e = enrich(bars);
  const hit = applyFilter(e, {
    conditions: [{ metric: "close_vs_sma20_pct", op: ">=", value: 0 }],
    logic: "AND",
    preset: null,
    interpretation: "",
    confidence: "high",
  });
  assert(hit.length === bars.length - 19, "close_vs_sma20_pct 조건은 워밍업 이후 봉만 통과");
}

console.log("\n[12] 이동평균선 골든/데드크로스");
{
  // 단순 이동평균 — naive 대조
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  const ma3 = movingAverage(values, 3);
  assert(ma3[0] === null && ma3[1] === null, "구간이 모자라는 앞쪽은 null");
  approx(ma3[2], 2, 1e-12, "MA(3) 첫 값 = (1+2+3)/3");
  approx(ma3[7], 7, 1e-12, "MA(3) 마지막 값 = (6+7+8)/3");
  assert(movingAverage(values, 20).every((v) => v === null), "봉보다 긴 기간이면 전부 null");

  // 상승 → 하락 → 상승. MA20 워밍업(20봉)이 끝난 뒤에 데드크로스와 골든크로스가 한 번씩.
  // (처음부터 하락하는 시계열은 관측이 시작될 때 이미 데드크로스 상태라 교차로 셀 수 없다.)
  const vshape: Pick<Bar, "date" | "close">[] = [];
  for (let i = 0; i < 120; i++) {
    const close = i < 30 ? 100 + i * 2 : i < 70 ? 160 - (i - 30) * 2 : 80 + (i - 70) * 2;
    vshape.push({ date: new Date(Date.UTC(2021, 0, 1 + i)).toISOString().slice(0, 10), close });
  }
  const crosses = detectMaCrosses(vshape, 5, 20);
  assert(crosses.length === 2, `상승→하락→상승 → 교차 2회 (실제 ${crosses.length}회)`);
  assert(crosses[0].type === "dead", "먼저 데드크로스");
  assert(crosses[1].type === "golden", "그 다음 골든크로스");
  assert(crosses[0].date < crosses[1].date, "교차는 시간순으로 나온다");
  assert(
    crosses.every((c) => c.fastValue !== c.slowValue),
    "교차 시점에는 두 선의 값이 다르다 (맞닿기만 한 봉은 제외)",
  );

  // 교차일 이후 20거래일 수익률
  const golden = crosses[1];
  const gi = vshape.findIndex((b) => b.date === golden.date);
  if (gi + 20 < vshape.length) {
    approx(
      golden.forwardReturn20d,
      ((vshape[gi + 20].close - vshape[gi].close) / vshape[gi].close) * 100,
      1e-9,
      "골든크로스 이후 20일 수익률 (naive 대조)",
    );
  }

  // 단조 상승이면 교차가 없다
  const rising = vshape.map((b, i) => ({ date: b.date, close: 100 + i }));
  assert(detectMaCrosses(rising, 5, 20).length === 0, "단조 상승 시계열에는 교차 없음");

  // 잘못된 기간은 안전하게 빈 배열
  assert(detectMaCrosses(vshape, 20, 5).length === 0, "단기 ≥ 장기면 교차를 계산하지 않음");
  assert(detectMaCrosses(vshape, 5, 5).length === 0, "두 기간이 같으면 교차 없음");
  assert(detectMaCrosses([], 5, 20).length === 0, "빈 시계열도 안전");

  // 두 선이 정확히 겹치기만 하고 되돌아가는 경우를 교차로 세지 않는지
  const touch: Pick<Bar, "date" | "close">[] = [];
  for (let i = 0; i < 60; i++) {
    touch.push({ date: new Date(Date.UTC(2022, 0, 1 + i)).toISOString().slice(0, 10), close: 100 });
  }
  assert(detectMaCrosses(touch, 5, 20).length === 0, "완전 평탄(두 선이 겹침) → 교차 0회");
}

console.log(
  failures === 0
    ? "\n✅ 전부 통과\n"
    : `\n❌ ${failures}개 실패\n`,
);
process.exit(failures === 0 ? 0 : 1);
