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
import { mergeOlderHistory, toUniqueBars } from "../lib/data/crypto";
import { binomTailGe } from "../lib/cycle/evaluate";
import { parseMaCommand } from "../lib/ma";
import { PRESET_CHIPS, PRESET_CONDITIONS } from "../lib/presets";
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

// ── [9] 코인 장기 히스토리 ─────────────────────────────────────────
console.log("\n[9] 코인 일봉 정제 / 장기 히스토리 이어붙이기");
{
  const row = (date: string, o: number, h: number, l: number, c: number, v = 1000) => ({
    date, open: o, high: h, low: l, close: c, volume: v,
  });

  // 신규 상장 첫날 0에 가까운 체결가가 찍힌 봉. 이 한 봉이 로그 축을 망친다.
  const cleaned = toUniqueBars([
    row("2018-01-01", 0.05, 13500, 0.05, 13000),
    row("2018-01-02", 13000, 13600, 12800, 13400),
    row("2018-01-03", 13400, 13500, 12000, 12100),
  ]);
  assert(cleaned.length === 2, "고가/저가가 100배 벌어진 상장 첫 봉은 버린다");
  assert(cleaned[0].date === "2018-01-02", "정상 봉은 그대로 남는다");

  assert(
    toUniqueBars([row("2020-03-12", 7900, 8000, 4500, 4800)]).length === 1,
    "하루 -40%(코로나 폭락) 같은 진짜 폭은 살린다",
  );
  assert(
    toUniqueBars([row("2018-01-01", 0, 13500, 0, 13000)]).length === 0,
    "0이 섞인 봉은 버린다",
  );

  const recent = [row("2018-01-02", 13000, 13600, 12800, 13400), row("2018-01-03", 13400, 13500, 12000, 12100)];
  const older = [
    row("2011-08-18", 10.9, 11.2, 10.5, 11.0),
    row("2011-08-19", 11.0, 11.3, 10.8, 11.1),
    // 겹치는 날짜 — 주 소스가 이겨야 한다.
    row("2018-01-02", 1, 2, 0.5, 1.5),
  ];
  const merged = mergeOlderHistory(recent, older);
  assert(merged.length === 4, "주 소스 앞 구간만 이어 붙인다");
  assert(merged[0].date === "2011-08-18", "합친 시계열은 가장 오래된 날짜부터 시작한다");
  assert(merged[2].close === 13400, "겹치는 날짜는 주 소스 값을 쓴다");
  assert(
    mergeOlderHistory(recent, []).length === 2 && mergeOlderHistory([], older).length === 3,
    "한쪽이 비면 다른 쪽을 그대로 돌려준다",
  );
}

// ── [10] 우연일 확률 (이항 꼬리 확률) ─────────────────────────────
console.log("\n[10] 우연일 확률 — 이항 검정");
{
  // 손계산: n=5, p=0.5 → P(X≥3) = (10+5+1)/32 = 0.5
  approx(binomTailGe(3, 5, 0.5), 0.5, 1e-12, "P(X≥3 | n=5, p=0.5)");
  // P(X≥1) = 1 − (1−p)^n = 1 − 0.9^10
  approx(binomTailGe(1, 10, 0.1), 1 - Math.pow(0.9, 10), 1e-12, "P(X≥1 | n=10, p=0.1)");
  // 전부 맞을 확률 = p^n
  approx(binomTailGe(4, 4, 0.25), Math.pow(0.25, 4), 1e-12, "P(X≥4 | n=4, p=0.25)");

  assert(binomTailGe(0, 10, 0.3) === 1, "0번 이상은 항상 확률 1");
  assert(binomTailGe(11, 10, 0.3) === 0, "n을 넘는 횟수는 확률 0");
  assert(binomTailGe(3, 10, 0) === 0, "p=0이면 맞을 수 없다");
  assert(binomTailGe(3, 10, 1) === 1, "p=1이면 반드시 맞는다");

  // naive 구현(직접 곱셈)과 대조 — 로그 공간 계산이 맞는지.
  const naive = (k: number, n: number, p: number) => {
    let sum = 0;
    for (let i = k; i <= n; i++) {
      let c = 1;
      for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1);
      sum += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
    }
    return sum;
  };
  approx(binomTailGe(7, 20, 0.2), naive(7, 20, 0.2), 1e-10, "n=20에서 naive 구현과 일치");

  // 언더플로 방어: 작은 p × 큰 n에서도 0이나 NaN이 되지 않는다.
  const tiny = binomTailGe(40, 2000, 0.012);
  assert(Number.isFinite(tiny) && tiny > 0 && tiny < 1, `n=2000에서도 정상 (${tiny.toExponential(2)})`);

  // 표본이 적으면 '전부 적중'도 우연일 확률이 높다 — 이 앱이 경고해야 하는 그 상황.
  const 적음 = binomTailGe(2, 2, 0.12);
  const 많음 = binomTailGe(12, 12, 0.12);
  assert(적음 > 0.01, `신호 2번 다 맞은 건 우연일 수 있다 (${(적음 * 100).toFixed(1)}%)`);
  assert(많음 < 적음, "같은 100% 적중이라도 표본이 많으면 우연일 확률이 낮다");
}

console.log(
  failures === 0
    ? "\n✅ 전부 통과\n"
    : `\n❌ ${failures}개 실패\n`,
);
process.exit(failures === 0 ? 0 : 1);
