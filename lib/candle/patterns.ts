/**
 * 캔들 패턴 사전.
 *
 * 설계 원칙 (lib/cycle/signals.ts와 같다):
 *
 * 1) 패턴은 '그 봉에서 완성되었는가'라는 하루짜리 사건으로 정의한다.
 *    상승장 지표는 켜짐/꺼짐이 이어지는 '상태'였지만, 캔들 패턴은 그날 한 번 나타났다
 *    사라지는 사건이다. 그래서 state가 아니라 at(해당 봉에서 완성)으로 둔다.
 *
 * 2) 파라미터는 교과서 값으로 고정한다.
 *    "아랫꼬리가 몸통의 2.3배일 때 제일 잘 맞았다" 같은 건 발견이 아니라 과최적화다.
 *    2배, 절반, 0.1처럼 사람이 책에서 읽는 숫자만 쓴다.
 *
 * 3) 크기는 항상 상대값으로 잰다.
 *    "몸통이 1,000원"은 삼성전자와 비트코인에서 뜻이 다르다. 몸통·꼬리는 그 봉의
 *    전체 범위(고가-저가)에 대한 비율로, 봉의 크기는 최근 20일 평균 범위에 대한
 *    배수로 잰다. 그래야 종목과 시대가 달라도 같은 자로 재게 된다.
 *
 * 4) 추세 조건을 넣은 것과 뺀 것을 같이 넣는다.
 *    교과서는 "망치형은 하락 뒤에 나와야 의미가 있다"고 말한다. 정말 그런지는
 *    둘 다 채점해서 비교하면 된다 — '망치형'(하락 뒤)과 '아랫꼬리 긴 봉'(모양만)이
 *    같이 들어 있는 이유다.
 */

import type { EnrichedBar } from "@/types";
import { sma } from "@/lib/cycle/ta";

export const PATTERN_GROUPS = ["단봉", "두봉", "세봉", "거래량·갭"] as const;
export type PatternGroup = (typeof PATTERN_GROUPS)[number];

/** 이 패턴이 교과서에서 어느 쪽을 가리킨다고 하는지. 채점 방향이 여기서 갈린다. */
export type PatternBias = "상승" | "하락";

export type PatternDef = {
  key: string;
  label: string;
  group: PatternGroup;
  bias: PatternBias;
  /** 왜 그렇게 읽는지 (교과서적 해석). */
  why: string;
  /** 실제 판정 조건. 화면에 그대로 보여준다 — 안 보여주면 무엇을 세었는지 알 수 없다. */
  rule: string;
  /** 앞선 추세를 조건에 넣었는지. */
  needsTrend: boolean;
};

export type PatternSeries = PatternDef & {
  /** 그 봉에서 패턴이 완성되었는지. 앞구간(데이터 부족)은 false. */
  at: boolean[];
};

/** 봉 하나의 해부. 화면의 '캔들 하나하나 읽기'가 이걸 그대로 쓴다. */
export type Anatomy = {
  date: string;
  bullish: boolean;
  /** 몸통이 전체 범위에서 차지하는 비율(%). */
  bodyPct: number;
  /** 윗꼬리 / 아랫꼬리가 전체 범위에서 차지하는 비율(%). */
  upperPct: number;
  lowerPct: number;
  /** 이 봉의 범위가 최근 20일 평균 범위의 몇 배인지. */
  rangeRatio: number | null;
  changePct: number | null;
  volumeRatio: number | null;
};

/** 도지로 볼 몸통 비율. 몸통이 범위의 10% 이하면 시가≈종가로 본다. */
const DOJI_BODY = 0.1;
/** 꼬리가 '길다'고 볼 기준. 몸통의 2배 (교과서 망치형 조건). */
const LONG_WICK = 2;
/** 장대봉으로 볼 몸통 비율과 크기. */
const MARUBOZU_BODY = 0.8;
const BIG_RANGE = 1.5;
/** 거래량 급증 기준. 20일 평균의 2배. */
const VOLUME_SURGE = 2;

type Shape = {
  body: number;
  range: number;
  upper: number;
  lower: number;
  bullish: boolean;
  top: number;
  bottom: number;
};

function shapeOf(b: EnrichedBar): Shape {
  const top = Math.max(b.open, b.close);
  const bottom = Math.min(b.open, b.close);
  return {
    body: Math.abs(b.close - b.open),
    range: Math.max(0, b.high - b.low),
    upper: Math.max(0, b.high - top),
    lower: Math.max(0, bottom - b.low),
    bullish: b.close > b.open,
    top,
    bottom,
  };
}

export function anatomyOf(bars: EnrichedBar[], i: number, avgRange: (number | null)[]): Anatomy {
  const b = bars[i];
  const s = shapeOf(b);
  const r = s.range > 0 ? s.range : null;
  const avg = avgRange[i];
  return {
    date: b.date,
    bullish: b.close >= b.open,
    bodyPct: r ? (s.body / r) * 100 : 0,
    upperPct: r ? (s.upper / r) * 100 : 0,
    lowerPct: r ? (s.lower / r) * 100 : 0,
    rangeRatio: avg != null && avg > 0 ? s.range / avg : null,
    changePct: i > 0 && bars[i - 1].close > 0 ? ((b.close - bars[i - 1].close) / bars[i - 1].close) * 100 : null,
    volumeRatio: b.volume_ratio_20d,
  };
}

/** 봉 하나를 한국어 한 마디로. 표에서 모양을 눈으로 좇을 수 있게. */
export function describeShape(a: Anatomy): string {
  const color = a.bullish ? "양봉" : "음봉";
  const big = a.rangeRatio != null && a.rangeRatio >= BIG_RANGE;
  const small = a.rangeRatio != null && a.rangeRatio <= 0.5;

  if (a.bodyPct <= DOJI_BODY * 100) {
    if (a.lowerPct >= 60) return "잠자리 도지";
    if (a.upperPct >= 60) return "비석 도지";
    return "도지";
  }
  if (a.bodyPct >= MARUBOZU_BODY * 100) return big ? `장대${color}` : `민${color}`;
  if (a.lowerPct >= 50) return `아랫꼬리 긴 ${color}`;
  if (a.upperPct >= 50) return `윗꼬리 긴 ${color}`;
  if (a.bodyPct <= 30) return small ? `작은 팽이형 ${color}` : `팽이형 ${color}`;
  return big ? `큰 ${color}` : small ? `작은 ${color}` : color;
}

/**
 * 캔들 배터리를 만든다.
 *
 * 앞선 추세는 두 가지로 잰다:
 *   하락 뒤 = 5거래일 전보다 종가가 낮고, 20일선 아래
 *   상승 뒤 = 5거래일 전보다 종가가 높고, 20일선 위
 * 캔들 책이 말하는 "하락 추세 끝에 나온 망치형"의 최소 조건이다. 이 조건을 아예
 * 빼면 위꼬리 달린 아무 봉이나 반전 신호가 되고, 너무 빡빡하게 잡으면 표본이 사라진다.
 */
export function buildPatterns(bars: EnrichedBar[]): PatternSeries[] {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const ranges = bars.map((b) => Math.max(0, b.high - b.low));
  const avgRange = sma(ranges, 20);
  const ma20 = sma(closes, 20);
  const s = bars.map(shapeOf);

  const downBefore: boolean[] = new Array(n).fill(false);
  const upBefore: boolean[] = new Array(n).fill(false);
  for (let i = 5; i < n; i++) {
    const m = ma20[i];
    if (m == null) continue;
    // 판정 시점은 '패턴이 완성되기 직전'이다. 오늘 종가로 추세를 재면
    // 오늘 크게 오른 봉이 '상승 추세 뒤'가 되어 버려서 순환 논리가 된다.
    const prev = bars[i - 1].close;
    downBefore[i] = prev < bars[i - 5].close && prev < m;
    upBefore[i] = prev > bars[i - 5].close && prev > m;
  }

  const bigEnough = (i: number): boolean => {
    const avg = avgRange[i];
    // 범위가 평균의 절반도 안 되는 봉은 모양을 논할 값이 없다(호가 단위 노이즈).
    return avg != null && avg > 0 && s[i].range >= avg * 0.5;
  };
  const surge = (i: number): boolean =>
    bars[i].volume_ratio_20d != null && bars[i].volume_ratio_20d! >= VOLUME_SURGE;

  const out: PatternSeries[] = [];
  const push = (def: PatternDef, test: (i: number) => boolean, from = 1) => {
    const at = new Array<boolean>(n).fill(false);
    for (let i = from; i < n; i++) {
      if (!bigEnough(i)) continue;
      at[i] = test(i);
    }
    if (at.some(Boolean)) out.push({ ...def, at });
  };

  // 몸통 대비 꼬리. 몸통이 0이면(도지) 비율이 무한대가 되므로 범위 기준으로 바꿔 잰다.
  const lowerLong = (i: number) =>
    s[i].body > 0 ? s[i].lower >= s[i].body * LONG_WICK : s[i].lower >= s[i].range * 0.6;
  const upperLong = (i: number) =>
    s[i].body > 0 ? s[i].upper >= s[i].body * LONG_WICK : s[i].upper >= s[i].range * 0.6;
  const upperSmall = (i: number) => s[i].upper <= s[i].range * 0.15;
  const lowerSmall = (i: number) => s[i].lower <= s[i].range * 0.15;
  const smallBody = (i: number) => s[i].body <= s[i].range * 0.35;

  // ── 단봉 ────────────────────────────────────────────────────────
  push(
    {
      key: "hammer",
      label: "망치형",
      group: "단봉",
      bias: "상승",
      why: "장중에 크게 밀렸다가 되돌려 마감. 저가에서 산 쪽이 이겼다는 흔적",
      rule: "하락 뒤 · 아랫꼬리 ≥ 몸통 2배 · 윗꼬리 ≤ 범위 15% · 몸통 ≤ 범위 35%",
      needsTrend: true,
    },
    (i) => downBefore[i] && lowerLong(i) && upperSmall(i) && smallBody(i),
    20,
  );
  push(
    {
      key: "long_lower",
      label: "아랫꼬리 긴 봉 (추세 무시)",
      group: "단봉",
      bias: "상승",
      why: "망치형에서 '하락 뒤'라는 조건만 뺀 것. 추세 조건이 정말 필요한지 비교용",
      rule: "아랫꼬리 ≥ 몸통 2배 · 윗꼬리 ≤ 범위 15% · 몸통 ≤ 범위 35% (앞선 추세는 안 봄)",
      needsTrend: false,
    },
    (i) => lowerLong(i) && upperSmall(i) && smallBody(i),
    20,
  );
  push(
    {
      key: "inverted_hammer",
      label: "역망치형",
      group: "단봉",
      bias: "상승",
      why: "하락 끝에 위로 찔러본 봉. 되밀렸지만 매수 시도가 처음 나온 자리",
      rule: "하락 뒤 · 윗꼬리 ≥ 몸통 2배 · 아랫꼬리 ≤ 범위 15%",
      needsTrend: true,
    },
    (i) => downBefore[i] && upperLong(i) && lowerSmall(i) && smallBody(i),
    20,
  );
  push(
    {
      key: "hanging_man",
      label: "교수형",
      group: "단봉",
      bias: "하락",
      why: "망치형과 같은 모양이지만 상승 끝에 나온다. 고점에서 한 번 밀렸다는 뜻",
      rule: "상승 뒤 · 아랫꼬리 ≥ 몸통 2배 · 윗꼬리 ≤ 범위 15%",
      needsTrend: true,
    },
    (i) => upBefore[i] && lowerLong(i) && upperSmall(i) && smallBody(i),
    20,
  );
  push(
    {
      key: "shooting_star",
      label: "유성형",
      group: "단봉",
      bias: "하락",
      why: "상승 끝에 위로 뻗었다가 되밀린 봉. 고점 매도 압력의 대표 모양",
      rule: "상승 뒤 · 윗꼬리 ≥ 몸통 2배 · 아랫꼬리 ≤ 범위 15%",
      needsTrend: true,
    },
    (i) => upBefore[i] && upperLong(i) && lowerSmall(i) && smallBody(i),
    20,
  );
  push(
    {
      key: "doji",
      label: "도지",
      group: "단봉",
      bias: "상승",
      why: "시가와 종가가 같다 = 균형. 추세 끝에 나오면 힘이 빠졌다는 신호로 읽는다",
      rule: "몸통 ≤ 범위 10%",
      needsTrend: false,
    },
    (i) => s[i].body <= s[i].range * DOJI_BODY,
    20,
  );
  push(
    {
      key: "dragonfly",
      label: "잠자리 도지",
      group: "단봉",
      bias: "상승",
      why: "장중 급락분을 전부 되돌린 도지. 바닥권 반전의 강한 형태로 본다",
      rule: "몸통 ≤ 범위 10% · 아랫꼬리 ≥ 범위 60%",
      needsTrend: false,
    },
    (i) => s[i].body <= s[i].range * DOJI_BODY && s[i].lower >= s[i].range * 0.6,
    20,
  );
  push(
    {
      key: "gravestone",
      label: "비석 도지",
      group: "단봉",
      bias: "하락",
      why: "장중 상승분을 전부 반납한 도지. 천장권 반전의 강한 형태로 본다",
      rule: "몸통 ≤ 범위 10% · 윗꼬리 ≥ 범위 60%",
      needsTrend: false,
    },
    (i) => s[i].body <= s[i].range * DOJI_BODY && s[i].upper >= s[i].range * 0.6,
    20,
  );
  push(
    {
      key: "marubozu_bull",
      label: "장대양봉",
      group: "단봉",
      bias: "상승",
      why: "꼬리 없이 위로만 간 큰 양봉. 하루 내내 매수가 이겼다",
      rule: "양봉 · 몸통 ≥ 범위 80% · 범위 ≥ 20일 평균 1.5배",
      needsTrend: false,
    },
    (i) =>
      s[i].bullish &&
      s[i].body >= s[i].range * MARUBOZU_BODY &&
      avgRange[i] != null &&
      s[i].range >= avgRange[i]! * BIG_RANGE,
    20,
  );
  push(
    {
      key: "marubozu_bear",
      label: "장대음봉",
      group: "단봉",
      bias: "하락",
      why: "꼬리 없이 아래로만 간 큰 음봉. 하루 내내 매도가 이겼다",
      rule: "음봉 · 몸통 ≥ 범위 80% · 범위 ≥ 20일 평균 1.5배",
      needsTrend: false,
    },
    (i) =>
      !s[i].bullish &&
      s[i].body >= s[i].range * MARUBOZU_BODY &&
      avgRange[i] != null &&
      s[i].range >= avgRange[i]! * BIG_RANGE,
    20,
  );
  push(
    {
      key: "spinning_top",
      label: "팽이형",
      group: "단봉",
      bias: "상승",
      why: "몸통이 작고 위아래 꼬리가 다 있다 = 방향을 못 정한 하루",
      rule: "몸통 ≤ 범위 30% · 윗꼬리·아랫꼬리 각각 ≥ 범위 25%",
      needsTrend: false,
    },
    (i) =>
      s[i].body <= s[i].range * 0.3 &&
      s[i].upper >= s[i].range * 0.25 &&
      s[i].lower >= s[i].range * 0.25,
    20,
  );

  // ── 두봉 ────────────────────────────────────────────────────────
  push(
    {
      key: "bull_engulf",
      label: "상승장악형",
      group: "두봉",
      bias: "상승",
      why: "어제 음봉 몸통을 오늘 양봉이 통째로 덮었다. 반전 패턴 중 가장 유명하다",
      rule: "하락 뒤 · 어제 음봉 · 오늘 양봉 · 오늘 몸통이 어제 몸통을 완전히 감쌈",
      needsTrend: true,
    },
    (i) =>
      downBefore[i] &&
      !s[i - 1].bullish &&
      s[i].bullish &&
      s[i].bottom <= s[i - 1].bottom &&
      s[i].top >= s[i - 1].top &&
      s[i].body > s[i - 1].body,
    21,
  );
  push(
    {
      key: "bull_engulf_vol",
      label: "상승장악형 + 거래량 급증",
      group: "거래량·갭",
      bias: "상승",
      why: "같은 장악형이라도 거래량이 붙어야 실제 손바뀜이라는 통설을 확인한다",
      rule: "상승장악형 · 당일 거래량 ≥ 20일 평균 2배",
      needsTrend: true,
    },
    (i) =>
      downBefore[i] &&
      !s[i - 1].bullish &&
      s[i].bullish &&
      s[i].bottom <= s[i - 1].bottom &&
      s[i].top >= s[i - 1].top &&
      surge(i),
    21,
  );
  push(
    {
      key: "bear_engulf",
      label: "하락장악형",
      group: "두봉",
      bias: "하락",
      why: "어제 양봉 몸통을 오늘 음봉이 통째로 덮었다",
      rule: "상승 뒤 · 어제 양봉 · 오늘 음봉 · 오늘 몸통이 어제 몸통을 완전히 감쌈",
      needsTrend: true,
    },
    (i) =>
      upBefore[i] &&
      s[i - 1].bullish &&
      !s[i].bullish &&
      s[i].bottom <= s[i - 1].bottom &&
      s[i].top >= s[i - 1].top &&
      s[i].body > s[i - 1].body,
    21,
  );
  push(
    {
      key: "piercing",
      label: "관통형",
      group: "두봉",
      bias: "상승",
      why: "갭 하락으로 시작해 어제 음봉의 절반 위까지 회복. 장악형의 약한 형태",
      rule: "하락 뒤 · 어제 음봉 · 오늘 시가 < 어제 저가 · 종가가 어제 몸통 중간 위, 시가 아래",
      needsTrend: true,
    },
    (i) => {
      const p = bars[i - 1];
      const mid = (p.open + p.close) / 2;
      return (
        downBefore[i] &&
        !s[i - 1].bullish &&
        s[i].bullish &&
        bars[i].open < p.low &&
        bars[i].close > mid &&
        bars[i].close < p.open
      );
    },
    21,
  );
  push(
    {
      key: "dark_cloud",
      label: "흑운형",
      group: "두봉",
      bias: "하락",
      why: "갭 상승으로 시작해 어제 양봉의 절반 아래로 마감. 관통형의 반대",
      rule: "상승 뒤 · 어제 양봉 · 오늘 시가 > 어제 고가 · 종가가 어제 몸통 중간 아래, 시가 위",
      needsTrend: true,
    },
    (i) => {
      const p = bars[i - 1];
      const mid = (p.open + p.close) / 2;
      return (
        upBefore[i] &&
        s[i - 1].bullish &&
        !s[i].bullish &&
        bars[i].open > p.high &&
        bars[i].close < mid &&
        bars[i].close > p.open
      );
    },
    21,
  );
  push(
    {
      key: "bull_harami",
      label: "상승잉태형",
      group: "두봉",
      bias: "상승",
      why: "큰 음봉 안에 작은 양봉이 들어앉았다. 하락 속도가 멈췄다는 신호",
      rule: "하락 뒤 · 어제 큰 음봉 · 오늘 몸통이 어제 몸통 안에 완전히 들어감",
      needsTrend: true,
    },
    (i) =>
      downBefore[i] &&
      !s[i - 1].bullish &&
      s[i].bullish &&
      s[i].top <= s[i - 1].top &&
      s[i].bottom >= s[i - 1].bottom &&
      s[i - 1].body > s[i].body * 2,
    21,
  );
  push(
    {
      key: "bear_harami",
      label: "하락잉태형",
      group: "두봉",
      bias: "하락",
      why: "큰 양봉 안에 작은 음봉이 들어앉았다. 상승 속도가 멈췄다는 신호",
      rule: "상승 뒤 · 어제 큰 양봉 · 오늘 몸통이 어제 몸통 안에 완전히 들어감",
      needsTrend: true,
    },
    (i) =>
      upBefore[i] &&
      s[i - 1].bullish &&
      !s[i].bullish &&
      s[i].top <= s[i - 1].top &&
      s[i].bottom >= s[i - 1].bottom &&
      s[i - 1].body > s[i].body * 2,
    21,
  );
  push(
    {
      key: "tweezer_bottom",
      label: "집게바닥",
      group: "두봉",
      bias: "상승",
      why: "이틀 연속 같은 저가에서 막혔다. 그 가격에 받치는 손이 있다는 뜻",
      rule: "하락 뒤 · 이틀 저가 차이 ≤ 0.3% · 오늘 양봉",
      needsTrend: true,
    },
    (i) =>
      downBefore[i] &&
      bars[i - 1].low > 0 &&
      Math.abs(bars[i].low - bars[i - 1].low) / bars[i - 1].low <= 0.003 &&
      s[i].bullish,
    21,
  );
  push(
    {
      key: "tweezer_top",
      label: "집게천장",
      group: "두봉",
      bias: "하락",
      why: "이틀 연속 같은 고가에서 막혔다. 그 가격에 파는 손이 있다는 뜻",
      rule: "상승 뒤 · 이틀 고가 차이 ≤ 0.3% · 오늘 음봉",
      needsTrend: true,
    },
    (i) =>
      upBefore[i] &&
      bars[i - 1].high > 0 &&
      Math.abs(bars[i].high - bars[i - 1].high) / bars[i - 1].high <= 0.003 &&
      !s[i].bullish,
    21,
  );

  // ── 세봉 ────────────────────────────────────────────────────────
  push(
    {
      key: "morning_star",
      label: "샛별형",
      group: "세봉",
      bias: "상승",
      why: "큰 음봉 → 작은 봉(휴지) → 큰 양봉. 반전 3봉 중 가장 신뢰한다고 알려진 형태",
      rule: "하락 뒤 · 1봉 큰 음봉 · 2봉 작은 몸통 · 3봉 양봉이 1봉 몸통 절반 위로 마감",
      needsTrend: true,
    },
    (i) => {
      const a = i - 2;
      const b = i - 1;
      const mid = (bars[a].open + bars[a].close) / 2;
      return (
        downBefore[b] &&
        !s[a].bullish &&
        s[a].body >= s[a].range * 0.5 &&
        s[b].body <= s[a].body * 0.5 &&
        s[i].bullish &&
        bars[i].close > mid
      );
    },
    22,
  );
  push(
    {
      key: "evening_star",
      label: "석별형",
      group: "세봉",
      bias: "하락",
      why: "큰 양봉 → 작은 봉 → 큰 음봉. 샛별형의 거울상",
      rule: "상승 뒤 · 1봉 큰 양봉 · 2봉 작은 몸통 · 3봉 음봉이 1봉 몸통 절반 아래로 마감",
      needsTrend: true,
    },
    (i) => {
      const a = i - 2;
      const b = i - 1;
      const mid = (bars[a].open + bars[a].close) / 2;
      return (
        upBefore[b] &&
        s[a].bullish &&
        s[a].body >= s[a].range * 0.5 &&
        s[b].body <= s[a].body * 0.5 &&
        !s[i].bullish &&
        bars[i].close < mid
      );
    },
    22,
  );
  push(
    {
      key: "three_white",
      label: "적삼병",
      group: "세봉",
      bias: "상승",
      why: "양봉 세 개가 계단처럼 올라간다. 추세가 붙었다는 확인형",
      rule: "3연속 양봉 · 종가가 매일 전날보다 높음 · 각 몸통 ≥ 범위 50%",
      needsTrend: false,
    },
    (i) =>
      [i - 2, i - 1, i].every((k) => s[k].bullish && s[k].body >= s[k].range * 0.5) &&
      bars[i].close > bars[i - 1].close &&
      bars[i - 1].close > bars[i - 2].close,
    22,
  );
  push(
    {
      key: "three_black",
      label: "흑삼병",
      group: "세봉",
      bias: "하락",
      why: "음봉 세 개가 계단처럼 내려간다. 하락 추세 확인형",
      rule: "3연속 음봉 · 종가가 매일 전날보다 낮음 · 각 몸통 ≥ 범위 50%",
      needsTrend: false,
    },
    (i) =>
      [i - 2, i - 1, i].every((k) => !s[k].bullish && s[k].body >= s[k].range * 0.5) &&
      bars[i].close < bars[i - 1].close &&
      bars[i - 1].close < bars[i - 2].close,
    22,
  );
  push(
    {
      key: "three_inside_up",
      label: "상승잉태 확인형",
      group: "세봉",
      bias: "상승",
      why: "상승잉태형이 나온 다음 날 실제로 위로 뚫었을 때만 센다. 확인을 붙이면 나아지는지 보는 것",
      rule: "상승잉태형 + 다음 날 종가가 잉태 첫 봉의 시가 위",
      needsTrend: true,
    },
    (i) => {
      const a = i - 2;
      const b = i - 1;
      return (
        downBefore[b] &&
        !s[a].bullish &&
        s[b].top <= s[a].top &&
        s[b].bottom >= s[a].bottom &&
        s[a].body > s[b].body * 2 &&
        bars[i].close > bars[a].open
      );
    },
    22,
  );

  // ── 거래량 · 갭 ─────────────────────────────────────────────────
  push(
    {
      key: "gap_up",
      label: "갭 상승",
      group: "거래량·갭",
      bias: "상승",
      why: "오늘 저가가 어제 고가보다 높다 = 사이에 거래가 없었다. 힘의 차이가 크다는 뜻",
      rule: "오늘 저가 > 어제 고가",
      needsTrend: false,
    },
    (i) => bars[i].low > bars[i - 1].high,
    21,
  );
  push(
    {
      key: "gap_down",
      label: "갭 하락",
      group: "거래량·갭",
      bias: "하락",
      why: "오늘 고가가 어제 저가보다 낮다. 갭 상승의 반대",
      rule: "오늘 고가 < 어제 저가",
      needsTrend: false,
    },
    (i) => bars[i].high < bars[i - 1].low,
    21,
  );
  push(
    {
      key: "capitulation",
      label: "투매 후 반전",
      group: "거래량·갭",
      bias: "상승",
      why: "거래량이 터진 날 크게 밀렸다가 되돌렸다. 마지막 투매를 받아낸 자리로 읽는다",
      rule: "하락 뒤 · 거래량 ≥ 20일 평균 2배 · 아랫꼬리 ≥ 범위 40% · 종가가 범위 상단 절반",
      needsTrend: true,
    },
    (i) =>
      downBefore[i] &&
      surge(i) &&
      s[i].lower >= s[i].range * 0.4 &&
      s[i].range > 0 &&
      (bars[i].close - bars[i].low) / s[i].range >= 0.5,
    21,
  );
  push(
    {
      key: "volume_dry_up",
      label: "거래량 실종 후 양봉",
      group: "거래량·갭",
      bias: "상승",
      why: "팔 사람이 다 팔면 거래량이 마른다. 그 뒤 첫 양봉을 바닥 신호로 보는 통설",
      rule: "하락 뒤 · 거래량 ≤ 20일 평균 60% · 양봉",
      needsTrend: true,
    },
    (i) =>
      downBefore[i] &&
      bars[i].volume_ratio_20d != null &&
      bars[i].volume_ratio_20d! <= 0.6 &&
      s[i].bullish,
    21,
  );

  return out;
}

/** 화면·테스트가 같은 평균 범위를 쓰도록 한 군데서 만든다. */
export function avgRangeSeries(bars: EnrichedBar[]): (number | null)[] {
  return sma(
    bars.map((b) => Math.max(0, b.high - b.low)),
    20,
  );
}
