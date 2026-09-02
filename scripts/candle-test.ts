/**
 * 캔들 패턴 분석 검산.
 *   npx tsx scripts/candle-test.ts            # 합성 데이터 (네트워크 불필요)
 *   npx tsx scripts/candle-test.ts BTC-USD    # 실데이터로 성적표 출력
 *
 * 합성 파트에서 확인하는 것 두 가지가 제일 중요하다:
 *   양성 대조 — 진짜로 캔들 뒤에 상승이 오도록 만든 시세에서는 A등급이 나와야 한다.
 *   음성 대조 — 아무 정보도 없는 랜덤워크에서는 A등급이 나오면 안 된다.
 * 둘 중 하나라도 깨지면 이 화면의 등급은 도장 찍어주는 기계다.
 */
import { enrich } from "../lib/indicators";
import {
  analyzeCandles,
  baselineStats,
  buildPatterns,
  circularShiftReturnP,
  describeShape,
  anatomyOf,
  avgRangeSeries,
  evaluatePattern,
  forwardSeries,
  gradePatterns,
  independentIndices,
  adverseAfter,
} from "../lib/candle";
import { narrate } from "../lib/candle/narrative";
import { parseAssistantIntent } from "../lib/assistant-intent";
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
  return new Date(Date.UTC(2006, 0, 1 + i)).toISOString().slice(0, 10);
}

/** 종가 배열 → 평범한 봉. 몸통 위아래로 0.3%씩 꼬리를 단다. */
function barsFromCloses(closes: number[]): Bar[] {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1];
    return {
      date: dateAt(i),
      open,
      high: Math.max(open, c) * 1.003,
      low: Math.min(open, c) * 0.997,
      close: c,
      volume: 1_000_000,
    };
  });
}

/** 지정한 봉을 망치형(작은 몸통 + 긴 아랫꼬리)으로 바꾼다. 종가는 그대로 둔다. */
function makeHammer(bars: Bar[], i: number) {
  const c = bars[i].close;
  bars[i] = {
    ...bars[i],
    open: c * 0.999,
    close: c,
    high: c * 1.0005,
    low: c * 0.96,
  };
}

const mulberry = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── 1. 봉 하나 읽기 ───────────────────────────────────────────────
console.log("\n[1] 캔들 해부 (몸통·꼬리 비율)");
{
  const bars = enrich(
    barsFromCloses(Array.from({ length: 40 }, (_, i) => 100 * Math.pow(0.99, i))),
  );
  const avg = avgRangeSeries(bars);

  // 손으로 계산: 시가 100, 고가 110, 저가 90, 종가 105 → 범위 20, 몸통 5, 윗꼬리 5, 아랫꼬리 10
  const hand = enrich([
    ...bars.slice(0, 30).map((b) => ({ ...b })),
    { date: dateAt(30), open: 100, high: 110, low: 90, close: 105, volume: 1_000_000 },
  ]);
  const a = anatomyOf(hand, 30, avgRangeSeries(hand));
  approx(a.bodyPct, 25, 1e-9, "몸통 = 범위의 25%");
  approx(a.upperPct, 25, 1e-9, "윗꼬리 = 범위의 25%");
  approx(a.lowerPct, 50, 1e-9, "아랫꼬리 = 범위의 50%");
  assert(a.bullish, "종가 > 시가면 양봉");
  assert(describeShape(a) === "아랫꼬리 긴 양봉", `모양 이름 (실제 "${describeShape(a)}")`);

  const doji = anatomyOf(
    enrich([{ date: dateAt(0), open: 100, high: 104, low: 96, close: 100.1, volume: 1 }]),
    0,
    [null],
  );
  assert(describeShape(doji) === "도지", `시가≈종가는 도지 (실제 "${describeShape(doji)}")`);

  // 범위가 0인 봉(상한가 붙어 한 가격에만 체결)에도 NaN이 없어야 한다.
  const flat = anatomyOf(
    enrich([{ date: dateAt(0), open: 100, high: 100, low: 100, close: 100, volume: 1 }]),
    0,
    [null],
  );
  assert(
    Number.isFinite(flat.bodyPct) && Number.isFinite(flat.upperPct) && Number.isFinite(flat.lowerPct),
    "범위 0인 봉도 NaN 없음",
  );
  assert(avg.length === bars.length, "평균 범위 시리즈 길이 = 봉 수");
}

// ── 2. 패턴 판정 ──────────────────────────────────────────────────
console.log("\n[2] 패턴 판정 (모양 + 앞선 추세)");
{
  const down = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(0.99, i));
  const bars = barsFromCloses(down);
  makeHammer(bars, 40);
  const enriched = enrich(bars);
  const at = (key: string, i: number) =>
    buildPatterns(enriched).find((p) => p.key === key)?.at[i] ?? false;

  assert(at("hammer", 40), "하락 뒤 긴 아랫꼬리 = 망치형");
  assert(at("long_lower", 40), "같은 봉이 '아랫꼬리 긴 봉'에도 잡힌다");
  assert(!at("hanging_man", 40), "하락 뒤였으므로 교수형은 아니다");
  assert(!at("hammer", 39), "평범한 봉에는 망치형이 없다");

  // 같은 모양을 상승 추세 끝에 놓으면 교수형이 되어야 한다.
  const up = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, i));
  const upBars = barsFromCloses(up);
  makeHammer(upBars, 40);
  const upEnriched = enrich(upBars);
  const atUp = (key: string) =>
    buildPatterns(upEnriched).find((p) => p.key === key)?.at[40] ?? false;
  assert(atUp("hanging_man"), "상승 뒤 같은 모양 = 교수형");
  assert(!atUp("hammer"), "상승 뒤였으므로 망치형은 아니다");
  assert(atUp("long_lower"), "추세를 안 보는 '아랫꼬리 긴 봉'은 양쪽 다 잡는다");

  // 상승장악형: 어제 음봉 몸통을 오늘 양봉이 완전히 덮는다.
  const engulf = barsFromCloses(down);
  const prevClose = engulf[39].close;
  engulf[40] = {
    date: dateAt(40),
    open: prevClose * 0.995,
    high: engulf[39].open * 1.02,
    low: prevClose * 0.99,
    close: engulf[39].open * 1.01,
    volume: 3_000_000,
  };
  const engulfPatterns = buildPatterns(enrich(engulf));
  assert(
    engulfPatterns.find((p) => p.key === "bull_engulf")?.at[40] === true,
    "하락 뒤 몸통을 덮는 양봉 = 상승장악형",
  );
  assert(
    engulfPatterns.find((p) => p.key === "bear_engulf")?.at[40] !== true,
    "같은 봉이 하락장악형으로 세지지는 않는다",
  );

  // '상승잉태 확인형'은 앞의 두 봉이 상승잉태형과 글자 그대로 같아야 한다.
  // 안쪽 봉이 양봉이라는 조건을 확인형에서만 빼면 다른 패턴을 세게 되어,
  // '확인을 붙이면 나아지는가'라는 비교 자체가 성립하지 않는다.
  {
    const three = barsFromCloses(down);
    const big = three[39];
    // 39: 큰 음봉으로 바꾼다 (몸통이 넉넉해야 안쪽 봉이 들어간다)
    three[39] = {
      date: dateAt(39),
      open: big.close * 1.08,
      high: big.close * 1.09,
      low: big.close * 0.99,
      close: big.close,
      volume: 1_000_000,
    };
    const outer = three[39];
    const mid = (outer.open + outer.close) / 2;
    // 40: 바깥 몸통 안에 들어가는 작은 '음'봉 (잉태형이 아니다)
    three[40] = {
      date: dateAt(40),
      open: mid * 1.005,
      high: mid * 1.012,
      low: mid * 0.995,
      close: mid,
      volume: 1_000_000,
    };
    // 41: 첫 봉 시가 위로 마감 = 확인
    three[41] = {
      date: dateAt(41),
      open: mid,
      high: outer.open * 1.03,
      low: mid * 0.99,
      close: outer.open * 1.02,
      volume: 1_000_000,
    };
    const bear = buildPatterns(enrich(three));
    assert(
      bear.find((p) => p.key === "bull_harami")?.at[40] !== true,
      "안쪽이 음봉이면 상승잉태형이 아니다 (전제 확인)",
    );
    assert(
      bear.find((p) => p.key === "three_inside_up")?.at[41] !== true,
      "잉태형이 아니면 '상승잉태 확인형'도 아니다",
    );

    // 안쪽 봉만 양봉으로 바꾸면 둘 다 잡혀야 한다.
    three[40] = { ...three[40], open: mid * 0.995, close: mid * 1.005 };
    const bull = buildPatterns(enrich(three));
    assert(
      bull.find((p) => p.key === "bull_harami")?.at[40] === true,
      "안쪽이 양봉이면 상승잉태형",
    );
    assert(
      bull.find((p) => p.key === "three_inside_up")?.at[41] === true,
      "그 다음 날 첫 봉 시가를 넘으면 확인형",
    );
  }

  // 앞선 추세는 '패턴이 완성되기 직전'까지의 값으로 재야 한다.
  //
  // 비교 대상인 20일선에 오늘 종가가 20분의 1 섞여 있으면, 오늘 봉이 자기 힘으로
  // 선을 넘겨 자기 자신의 '앞선 추세'를 만들어낸다. 아래 두 시계열은 그게 갈리는
  // 자리다 — 어제까지의 20일선은 정확히 종가와 같아서(100) 추세가 안 정해지는데,
  // 오늘 한 봉이 크게 움직이면 20일선이 100을 넘거나 밑돌면서 분류가 뒤집힌다.
  {
    // 5일간 96→100으로 오르지만 종가는 20일선 위로 못 올라온 상태.
    // 오늘 급락(60)이 20일선을 97.5로 끌어내리면 '상승 뒤'로 오분류된다.
    const upTrap = [...Array(21).fill(110), ...Array(14).fill(100), 96, 97, 98, 99, 100, 60];
    const crash = barsFromCloses(upTrap);
    crash[40] = { date: dateAt(40), open: 61, high: 61.2, low: 40, close: 60, volume: 1_000_000 };
    assert(
      buildPatterns(enrich(crash)).find((p) => p.key === "hanging_man")?.at[40] !== true,
      "오늘 급락이 20일선을 끌어내려도 '상승 뒤'가 되지 않는다 (교수형 아님)",
    );

    // 거울상: 5일간 104→100으로 내리지만 20일선 아래로는 안 내려온 상태.
    // 오늘 급등(140)이 20일선을 102.5로 밀어 올리면 '하락 뒤'로 오분류된다.
    const downTrap = [...Array(21).fill(90), ...Array(14).fill(100), 104, 103, 102, 101, 100, 140];
    const pop = barsFromCloses(downTrap);
    pop[40] = { date: dateAt(40), open: 141, high: 141.2, low: 120, close: 140, volume: 1_000_000 };
    assert(
      buildPatterns(enrich(pop)).find((p) => p.key === "hammer")?.at[40] !== true,
      "오늘 급등이 20일선을 밀어 올려도 '하락 뒤'가 되지 않는다 (망치형 아님)",
    );
  }

  // 갭: 오늘 저가가 어제 고가보다 위.
  const gap = barsFromCloses(down);
  const g = gap[39].high * 1.02;
  gap[40] = { date: dateAt(40), open: g, high: g * 1.01, low: g, close: g * 1.008, volume: 1_000_000 };
  assert(
    buildPatterns(enrich(gap)).find((p) => p.key === "gap_up")?.at[40] === true,
    "저가 > 어제 고가 = 갭 상승",
  );
}

// ── 3. 미래를 보지 않는지 ─────────────────────────────────────────
//
// 캔들 판정에 '오늘 종가'가 들어가는 건 정상이지만, 내일 이후 봉이 들어가면
// 성적표 전체가 미래 참조로 오염된다. 시계열을 잘라도 판정이 같은지로 확인한다.
console.log("\n[3] 미래 참조 방지");
{
  const rand = mulberry(7);
  const closes = [100];
  for (let i = 1; i < 600; i++) closes.push(Math.max(1, closes[i - 1] * (1 + (rand() - 0.5) * 0.05)));
  const bars = barsFromCloses(closes).map((b, i) => {
    // 꼬리 길이를 봉마다 다르게 해서 여러 패턴이 실제로 걸리게 한다.
    const wick = 0.005 + rand() * 0.03;
    return {
      ...b,
      high: Math.max(b.open, b.close) * (1 + wick * rand()),
      low: Math.min(b.open, b.close) * (1 - wick * rand()),
      volume: Math.round(500_000 + rand() * 3_000_000),
    };
  });
  const full = buildPatterns(enrich(bars));

  let mismatched = 0;
  let fired = 0;
  for (const cut of [300, 450, 599]) {
    const prefix = buildPatterns(enrich(bars.slice(0, cut + 1)));
    for (const p of full) {
      const q = prefix.find((x) => x.key === p.key);
      const before = p.at[cut];
      const after = q?.at[cut] ?? false;
      if (before) fired++;
      if (before !== after) mismatched++;
    }
  }
  assert(fired > 0, `검사한 시점에 실제로 패턴이 떴다 (${fired}건)`);
  assert(mismatched === 0, `뒤 봉을 잘라내도 판정이 같다 (다른 것 ${mismatched}건)`);
}

// ── 4. 통계 도구 ──────────────────────────────────────────────────
console.log("\n[4] 표본 겹침 보정 · 순환 이동 검정 · 역행폭");
{
  assert(
    JSON.stringify(independentIndices([1, 2, 3, 10, 11, 30], 5)) === JSON.stringify([1, 10, 30]),
    "5일 안에 겹친 발생은 하나로 (겹치지 않는 것만 남김)",
  );
  assert(
    independentIndices([], 5).length === 0 && independentIndices([4], 5).length === 1,
    "빈 목록과 한 개짜리도 처리",
  );

  // 수익률이 특정 구간에만 몰려 있는 가짜 시계열.
  const fwd: (number | null)[] = new Array(1000).fill(0);
  for (let i = 100; i < 150; i++) fwd[i] = 5;
  const inside = circularShiftReturnP([100, 110, 120, 130], fwd, 1);
  const outside = circularShiftReturnP([300, 500, 700, 900], fwd, 1);
  assert(inside != null && inside < 0.1, `좋은 구간에만 뜬 패턴은 우연일 확률이 낮다 (${inside})`);
  assert(
    outside != null && inside != null && inside < outside,
    `아무 데나 뜬 패턴보다 우연 같지 않다 (${inside} < ${outside})`,
  );
  assert(circularShiftReturnP([], fwd, 1) === null, "발생이 없으면 확률을 못 잰다");

  // 하락형(dir=-1)은 부호를 뒤집어 본다: 같은 시계열이면 확률이 정반대로 나와야 한다.
  const bearInside = circularShiftReturnP([100, 110, 120, 130], fwd, -1);
  assert(
    bearInside != null && bearInside > 0.9,
    `상승 구간에 뜬 하락형은 우연일 확률이 높다 (${bearInside})`,
  );

  // 역행폭: 진입 뒤 최저 종가까지의 낙폭. 계속 오르기만 하면 0.
  const rising = enrich(barsFromCloses(Array.from({ length: 60 }, (_, i) => 100 + i)));
  const noDip = adverseAfter(rising, [10, 20], 5, 1);
  assert(noDip.medianPct === 0, `계속 오르면 역행폭 0 (실제 ${noDip.medianPct})`);
  const asBear = adverseAfter(rising, [10, 20], 5, -1);
  assert(
    asBear.medianPct != null && asBear.medianPct < 0,
    `같은 구간을 하락형으로 보면 역행 (실제 ${asBear.medianPct})`,
  );
}

// ── 5. 양성 대조군 — 진짜 신호는 A등급이 나와야 한다 ──────────────
console.log("\n[5] 양성 대조군 (망치형 뒤에 반드시 오르는 시세)");
{
  const n = 3000;
  const events: number[] = [];
  for (let e = 200; e < n - 60; e += 45) events.push(e);

  // 사건마다: 6일간 -3% 하락 → 망치형 → 5일간 +5% 반등 → 25일에 걸쳐 원위치.
  const extra = new Array(n).fill(0);
  for (const e of events) {
    for (let k = 1; k <= 6; k++) extra[e - 7 + k] = (-0.03 * k) / 6;
    extra[e] = -0.03;
    for (let k = 1; k <= 5; k++) extra[e + k] = -0.03 + (0.05 * k) / 5;
    for (let k = 1; k <= 25; k++) extra[e + 5 + k] = 0.02 * (1 - k / 25);
  }
  const closes = Array.from(
    { length: n },
    (_, i) => 100 * (1 + 0.005 * Math.sin(i / 9)) * (1 + extra[i]),
  );
  const bars = barsFromCloses(closes);
  for (const e of events) makeHammer(bars, e);

  const enriched = enrich(bars);
  const report = analyzeCandles("TEST", enriched, { horizon: 5 });
  const hammer = report.patterns.find((p) => p.key === "hammer");

  assert(hammer != null, "망치형이 성적표에 있다");
  assert(
    (hammer?.count ?? 0) >= events.length * 0.9,
    `심어둔 망치형 ${events.length}개 중 ${hammer?.count ?? 0}개를 잡았다`,
  );
  assert(
    hammer?.successRate != null && hammer.successRate >= 95,
    `방향 적중률 ${hammer?.successRate?.toFixed(0)}%`,
  );
  assert(
    hammer?.rateEdge != null && hammer.rateEdge > 20,
    `기저 적중률보다 ${hammer?.rateEdge?.toFixed(0)}%p 높다`,
  );
  assert(
    hammer?.chance != null && hammer.chance < 0.01,
    `우연일 확률 ${((hammer?.chance ?? 1) * 100).toFixed(2)}%`,
  );
  assert(hammer?.grade === "A", `망치형 등급 A (실제 ${hammer?.grade}, ${hammer?.passCount}/6)`);
  assert(hammer?.walkForward?.heldUp === true, "앞뒤 기간 모두 통과");

  // 방향 처리 검산.
  //
  // "이 시세엔 하락형 A등급이 없어야 한다"로는 확인할 수 없다. 위 시세는 반등분이
  // 25일에 걸쳐 되돌아오도록 만들었으므로 되돌림 구간에는 진짜 하락 신호가 들어 있고,
  // 채점기가 그걸 찾아내는 건 옳은 동작이다. 대신 같은 발생일을 방향만 뒤집어 채점한다:
  // 상승형으로 100% 맞은 신호는 하락형으로 보면 0%가 나와야 한다.
  const hammerSeries = buildPatterns(enriched).find((p) => p.key === "hammer")!;
  const mirrored = gradePatterns([
    evaluatePattern(
      enriched,
      { ...hammerSeries, key: "hammer_as_bear", label: "망치형(방향만 뒤집음)", bias: "하락" },
      baselineStats(enriched),
      { horizon: 5 },
    ),
  ])[0];
  assert(
    mirrored.successRate != null && mirrored.successRate < 5,
    `방향을 뒤집으면 적중률이 무너진다 (실제 ${mirrored.successRate?.toFixed(0)}%)`,
  );
  assert(
    mirrored.chance != null && mirrored.chance > 0.9,
    `뒤집은 쪽은 우연일 확률이 높다 (실제 ${mirrored.chance?.toFixed(2)})`,
  );
  assert(mirrored.grade === "D", `뒤집은 쪽 등급 D (실제 ${mirrored.grade})`);

  // 마지막 봉 기준 전망이 채워지는지 (심어둔 사건이 없어도 문장은 나와야 한다).
  assert(report.outlook.basis.length > 20, "전망 문장이 만들어진다");
  assert(!/NaN|undefined/.test(report.outlook.basis), "전망 문장에 NaN/undefined 없음");
  assert(!/NaN|undefined/.test(narrate(report)), "요약 문장에 NaN/undefined 없음");
  assert(narrate(report).length > 100, "요약 문장 길이");
}

// ── 6. 음성 대조군 — 랜덤워크에서는 A등급이 없어야 한다 ────────────
console.log("\n[6] 음성 대조군 (랜덤워크)");
{
  for (const seed of [1, 2026]) {
    const rand = mulberry(seed);
    const bars: Bar[] = [];
    let close = 1000;
    for (let i = 0; i < 3000; i++) {
      const open = close;
      const z = rand() + rand() + rand() + rand() + rand() + rand() - 3;
      close = Math.max(1, open * Math.exp(0.0003 + 0.02 * z));
      const hi = Math.max(open, close) * (1 + rand() * 0.02);
      const lo = Math.min(open, close) * (1 - rand() * 0.02);
      bars.push({
        date: dateAt(i),
        open,
        high: hi,
        low: lo,
        close,
        volume: Math.round(500_000 * (0.5 + rand() * 3)),
      });
    }
    const report = analyzeCandles("TEST", enrich(bars), { horizon: 5 });

    // 검사 자체가 비어 있으면 통과해도 의미가 없다.
    const testable = report.patterns.filter((p) => p.independentCount >= 20);
    assert(testable.length >= 8, `seed ${seed}: 채점 가능한 패턴이 ${testable.length}가지 있다`);

    const aGrade = report.patterns.filter((p) => p.grade === "A");
    assert(
      aGrade.length === 0,
      `seed ${seed}: 랜덤워크에 A등급 없음 (실제 ${aGrade.length}개: ${aGrade.map((p) => p.label).join(", ")})`,
    );
    const significant = report.patterns.filter((p) => p.qValue != null && p.qValue < 0.1);
    assert(
      significant.length <= 2,
      `seed ${seed}: 보정 후 유의한 게 거의 없다 (실제 ${significant.length}개)`,
    );
    assert(
      report.outlook.usable.length === 0 || aGrade.length + report.patterns.filter((p) => p.grade === "B").length > 0,
      `seed ${seed}: 근거 없는 전망을 만들지 않는다`,
    );
  }
}

// ── 7. 전체 파이프라인 불변식 ─────────────────────────────────────
console.log("\n[7] 파이프라인 불변식");
{
  const rand = mulberry(99);
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < 1500; i++) {
    const open = close;
    close = Math.max(1, open * (1 + (rand() - 0.48) * 0.04));
    bars.push({
      date: dateAt(i),
      open,
      high: Math.max(open, close) * (1 + rand() * 0.015),
      low: Math.min(open, close) * (1 - rand() * 0.015),
      close,
      volume: Math.round(1_000_000 * (0.4 + rand() * 2)),
    });
  }
  const enriched = enrich(bars);
  const report = analyzeCandles("TEST", enriched, { horizon: 10, readBars: 30 });

  assert(report.patterns.length >= 15, `패턴 ${report.patterns.length}가지 채점`);
  assert(
    report.patterns.every((p) => p.occurrences.length === p.count),
    "발생 날짜 수 = 발생 횟수",
  );
  assert(
    report.patterns.every((p) => p.independentCount <= p.count),
    "겹치지 않는 발생 ≤ 전체 발생",
  );
  assert(
    report.patterns.every((p) => p.winDates.length <= p.count),
    "맞은 날 ≤ 전체 발생",
  );
  assert(
    report.patterns.every((p) => new Set(p.occurrences).size === p.occurrences.length),
    "같은 날이 두 번 세어지지 않는다",
  );
  assert(
    report.patterns.every(
      (p) => p.successRate == null || (p.successRate >= 0 && p.successRate <= 100),
    ),
    "적중률은 0~100%",
  );
  assert(
    report.patterns.every((p) => p.qValue == null || p.chance == null || p.qValue >= p.chance),
    "보정 후 q값은 원래 p값보다 작지 않다",
  );
  assert(report.patterns.every((p) => p.checks.length === 6), "모든 패턴에 관문 6개");
  assert(
    report.patterns.every((p) => (p.grade === "A") === (p.passCount === 6)),
    "A등급 = 여섯 관문 전부 통과",
  );
  assert(
    report.patterns.every((p) => p.adverse.medianPct == null || p.adverse.medianPct <= 0),
    "역행폭은 0 이하",
  );
  assert(
    report.patterns.every(
      (p) => p.forward["10"].n <= p.count && p.forward["10"].n >= p.count - 10,
    ),
    "채점된 표본 수는 발생 수에서 끝부분만큼만 빠진다",
  );
  assert(report.read.length === 30, `읽은 봉 ${report.read.length}개`);
  assert(
    report.read[report.read.length - 1].date === bars[bars.length - 1].date,
    "읽기 목록의 마지막이 최신 봉",
  );
  assert(
    report.read.slice(-10).every((b) => b.forwardPct === null || b.forwardPct != null),
    "최근 봉의 미래 수익률은 없으면 null",
  );
  assert(
    report.read[report.read.length - 1].forwardPct === null,
    "마지막 봉은 아직 미래가 없다",
  );
  assert(report.warnings.length >= 6, `경고 문구 ${report.warnings.length}개`);
  assert(
    report.warnings.every((w) => !/NaN|undefined/.test(w)),
    "경고 문구에 NaN/undefined 없음",
  );
  assert(report.horizon === 10, "요청한 채점 구간이 리포트에 반영된다");

  // 기저율은 리포트 밖에서 다시 계산해도 같아야 한다 (화면과 성적표가 같은 자를 쓴다).
  const base = baselineStats(enriched).byHorizon["10"];
  approx(
    report.baseline.byHorizon["10"].avg,
    base.avg ?? 0,
    1e-9,
    "리포트의 기저 평균 = 독립 계산값",
  );

  // 패턴 하나를 직접 채점해도 같은 숫자가 나오는지 (index.ts가 옵션을 흘리는지 확인).
  const series = buildPatterns(enriched);
  const one = series[0];
  const solo = evaluatePattern(enriched, one, baselineStats(enriched), { horizon: 10 });
  const fromReport = report.patterns.find((p) => p.key === one.key);
  assert(solo.count === fromReport?.count, "직접 채점과 리포트의 발생 수가 같다");
  approx(solo.successRate, fromReport?.successRate ?? 0, 1e-9, "적중률도 같다");

  // forwardSeries는 그 봉 종가 대비 horizon 뒤 종가 수익률이어야 한다.
  const fwd = forwardSeries(enriched, 10);
  const i = 100;
  approx(
    fwd[i],
    ((enriched[i + 10].close - enriched[i].close) / enriched[i].close) * 100,
    1e-9,
    "전방 수익률 정의",
  );
  assert(fwd[enriched.length - 1] === null, "마지막 봉의 전방 수익률은 null");
}

// ── 8. AI 비서가 캔들 질문을 캔들 화면으로 보내는지 ────────────────
console.log("\n[8] 비서 의도 분류");
{
  const kind = (s: string) => parseAssistantIntent(s).kind;
  assert(kind("망치형 나오면 오르는 편이야?") === "candle", "패턴 이름 → 캔들");
  assert(kind("NVDA 장악형 어때") === "candle", "장악형 → 캔들");
  assert(kind("이 캔들 모양 분석해줘") === "candle", "캔들 + 분석 → 캔들");
  assert(kind("적삼병 뜨면 어떻게 됐어?") === "candle", "적삼병 → 캔들");
  // 기존 분류를 뺏지 않아야 한다.
  assert(kind("BTC 상승장 언제 왔어?") === "cycle", "상승장 질문은 그대로 사이클");
  assert(kind("200일 이평선 돌파 30일 후 어떻게됐어?") === "ma_breakout", "돌파 질문은 그대로");
  assert(
    kind("10일만에 10%이상 급등 20일전 거래량 분석해줘") === "surge_prelude",
    "급등 질문은 그대로",
  );
  const withTicker = parseAssistantIntent("망치형 어때 NVDA");
  assert(
    withTicker.kind === "candle" && withTicker.ticker === "NVDA",
    "질문에서 티커를 뽑는다",
  );
}

// ── 9. 실데이터 (인자로 티커를 주면) ──────────────────────────────
const ticker = process.argv[2];
if (ticker) {
  console.log(`\n[9] 실데이터: ${ticker}`);
  (async () => {
    const { loadBars, MAX_YEARS } = await import("../lib/data");
    const { normalizeTicker } = await import("../lib/data/provider");
    const t = normalizeTicker(ticker);
    const raw = await loadBars(t, { years: MAX_YEARS });
    const report = analyzeCandles(t, enrich(raw), { horizon: 5 });
    const base = report.baseline.byHorizon["5"];

    console.log(`  기간 ${report.periodStart} ~ ${report.periodEnd} (${report.totalBars}봉)`);
    console.log(
      `  기저: 5거래일 뒤 상승 ${base.upRate?.toFixed(1)}% · 평균 ${base.avg?.toFixed(2)}%`,
    );
    console.log("\n  --- 상위 12개 ---");
    for (const p of report.patterns.slice(0, 12)) {
      console.log(
        `  ${p.grade} ${p.passCount}/6 ${p.label.padEnd(22)}` +
          ` ${String(p.count).padStart(4)}회(독립 ${String(p.independentCount).padStart(3)})` +
          ` 적중 ${(p.successRate?.toFixed(0) ?? "—").padStart(3)}%` +
          ` (기저 ${(p.baseRate?.toFixed(0) ?? "—").padStart(3)}%,` +
          ` ${(p.rateEdge == null ? "—" : (p.rateEdge >= 0 ? "+" : "") + p.rateEdge.toFixed(1)).padStart(5)}%p)` +
          ` 평균 ${(p.avgMovePct?.toFixed(2) ?? "—").padStart(6)}%` +
          ` q ${(p.qValue == null ? "—" : (p.qValue * 100).toFixed(1)).padStart(5)}%`,
      );
    }
    console.log("\n  --- 최근 8봉 ---");
    for (const b of report.read.slice(-8)) {
      console.log(
        `  ${b.date} ${b.shape.padEnd(16)} ${(b.changePct?.toFixed(2) ?? "—").padStart(6)}%` +
          `  ${b.patterns.map((h) => `${h.label}(${h.grade})`).join(", ")}`,
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
