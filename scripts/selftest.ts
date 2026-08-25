/**
 * 지표·통계 검산 (외부 API 불필요).
 *   npx tsx scripts/selftest.ts
 *
 * 방식 2가지:
 *  1) 손으로 계산한 상수와 비교
 *  2) 본 구현과 다르게 짠 naive 구현과 비교
 */
import { enrich } from "../lib/indicators";
import { applyFilter, clusterIndices, enforceMinGap } from "../lib/filter";
import { analyze, forwardReturn, maxForwardReturn, resolveTrigger } from "../lib/stats";
import { PRESET_CHIPS, PRESET_CONDITIONS, PRESET_TRIGGERS } from "../lib/presets";
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
    expected.every((name) => PRESET_TRIGGERS[name] != null),
    "모든 프리셋에 발화 규칙이 정의됨",
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
    PRESET_TRIGGERS.accumulation.fresh_only && PRESET_TRIGGERS.accumulation.min_gap_days === 20,
    "누적 매집 = 진입 첫날만 · 최소 간격 20거래일",
  );
  assert(
    PRESET_TRIGGERS.stealth_accumulation.fresh_only &&
      PRESET_TRIGGERS.flow_improvement.fresh_only,
    "상태 지표 기반 프리셋은 전부 fresh_only",
  );
  assert(
    !PRESET_TRIGGERS.absorption.fresh_only && !PRESET_TRIGGERS.strong_breakout.fresh_only,
    "이벤트 지표 기반 프리셋은 fresh_only를 걸지 않음",
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

console.log("\n[9] 발화 규칙 (첫 진입만 · 최소 간격)");
{
  assert(
    JSON.stringify(enforceMinGap([0, 3, 7, 21, 22, 40], 10)) === "[0,21,40]",
    "최소 간격 10일 → 붙은 신호 제거",
  );
  assert(
    JSON.stringify(enforceMinGap([0, 3, 7], 0)) === "[0,3,7]",
    "간격 0이면 그대로 통과",
  );

  // 상태 지표를 흉내낸 픽스처: 거래량이 40~79번 봉에서 계속 높게 유지된다.
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2020, 0, 1 + i));
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: i >= 40 && i < 80 ? 3_000_000 : 1_000_000,
      // 40번 봉부터 거래량이 3배로 올라 20일 내내 조건이 참인 "국면"을 만든다
    });
    close *= 1.001;
  }
  const e = enrich(bars);
  const base = { logic: "AND" as const, preset: null, interpretation: "", confidence: "high" as const };
  const conditions = [{ metric: "volume_ratio_20d" as const, op: ">=" as const, value: 1.5 }];

  const all = applyFilter(e, { ...base, conditions });
  const fresh = applyFilter(e, { ...base, conditions, fresh_only: true });
  assert(all.length >= 10, `발화 규칙 없으면 ${all.length}일 매칭 (국면 하나가 통째로 잡힘)`);
  assert(fresh.length === 1, `fresh_only → 진입 첫날 1일만 (실제 ${fresh.length}일)`);
  assert(fresh[0] === 40, "진입 첫날 = 40번 봉");

  // applyTrigger:false는 fresh_only를 무시하고 원본 매칭을 그대로 준다
  const raw = applyFilter(e, { ...base, conditions, fresh_only: true }, { applyTrigger: false });
  assert(raw.length === all.length, "applyTrigger:false → 원본 매칭 수 그대로");

  // analyze가 규칙 적용 전/후를 함께 보고한다
  const spec: FilterSpec = { ...base, conditions, fresh_only: true, min_gap_days: 20 };
  const r = analyze("TEST", e, spec, { cluster: false });
  assert(r.rawMatchCount === all.length, `rawMatchCount = ${all.length} (규칙 적용 전)`);
  assert(r.stats.matchCount === 1, "규칙 적용 후 신호 1개");
  assert(r.suppressedCount === all.length - 1, "suppressedCount = 억제된 신호 수");
  assert(r.trigger.freshOnly && r.trigger.minGapDays === 20, "결과에 적용된 발화 규칙이 실림");
  assert(
    r.warnings.some((w) => w.includes("신호") && w.includes("정리했습니다")),
    "억제 사실을 경고로 알림",
  );

  // 규칙을 끄면 예전 동작 그대로
  const off = analyze("TEST", e, { ...spec, fresh_only: false, min_gap_days: 0 }, { cluster: false });
  assert(off.stats.matchCount === all.length, "규칙을 끄면 전체 매칭 (하위 호환)");
}

console.log("\n[10] 프리셋 기본 발화 규칙 / 스펙 검증");
{
  // 스펙에 명시가 없으면 프리셋 기본값을 쓴다
  const spec: FilterSpec = {
    conditions: PRESET_CONDITIONS.accumulation,
    logic: "AND",
    preset: "accumulation",
    interpretation: "",
    confidence: "high",
  };
  const t = resolveTrigger(spec);
  assert(t.freshOnly && t.minGapDays === 20, "프리셋 기본 발화 규칙 적용");

  // 사용자가 명시하면 그게 이긴다
  const overridden = resolveTrigger({ ...spec, fresh_only: false, min_gap_days: 5 });
  assert(!overridden.freshOnly && overridden.minGapDays === 5, "명시된 규칙이 프리셋 기본값을 덮어씀");

  // 프리셋이 없으면 규칙 없음 (예전 동작)
  const none = resolveTrigger({ ...spec, preset: null });
  assert(!none.freshOnly && none.minGapDays === 0, "프리셋 없으면 규칙 없음");

  // validateSpec이 발화 규칙을 통과시키고 상한을 건다
  const v = validateSpec({
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 2 }],
    logic: "AND",
    fresh_only: true,
    min_gap_days: 999,
    interpretation: "테스트",
    confidence: "high",
  });
  assert(v.fresh_only === true, "validateSpec: fresh_only 통과");
  assert(v.min_gap_days === 120, "validateSpec: min_gap_days 상한 120 적용");

  const v2 = validateSpec({
    conditions: [{ metric: "volume_ratio_20d", op: ">=", value: 2 }],
    logic: "AND",
    min_gap_days: "이상한값",
    interpretation: "테스트",
    confidence: "high",
  });
  assert(v2.min_gap_days === undefined, "validateSpec: 숫자가 아니면 버리고 프리셋 기본값에 맡김");

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

console.log(
  failures === 0
    ? "\n✅ 전부 통과\n"
    : `\n❌ ${failures}개 실패\n`,
);
process.exit(failures === 0 ? 0 : 1);
