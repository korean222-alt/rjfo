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
import type { Bar, FilterSpec } from "../types";

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

console.log(
  failures === 0
    ? "\n✅ 전부 통과\n"
    : `\n❌ ${failures}개 실패\n`,
);
process.exit(failures === 0 ? 0 : 1);
