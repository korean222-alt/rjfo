/**
 * 캔들 패턴 × 그 다음에 실제로 벌어진 일 = 성적표.
 *
 * 묻는 것은 하나다: "이 모양이 나온 다음 N거래일 동안, 아무 날에나 산 것보다 나았나?"
 *
 * 여기서 재는 것:
 *   방향 적중률 — 패턴이 가리킨 쪽(상승형이면 상승)으로 실제로 간 비율
 *   기저 대비   — 그 적중률이 '아무 날이나 골랐을 때'보다 몇 %p 높은가
 *   초과 수익   — 평균 수익률 − 기저 평균 수익률 (방향을 곱한 값)
 *   역행폭      — 들고 가는 동안 반대로 얼마나 밀렸나 (평균 수익만 보면 안 보인다)
 *   우연일 확률 — 아무 데나 같은 횟수만큼 찍어도 이만큼 나올 확률
 *
 * 기저율을 빼는 게 핵심이다. 우상향하는 종목은 아무 날이나 사도 5일 뒤 오를 확률이
 * 55%다. 그걸 안 빼면 모든 상승 패턴이 "적중률 55%!"가 되어 전부 훌륭해 보인다.
 *
 * 통계 도구(이항 검정·순환 이동 검정·BH 보정)는 상승장 지표 쪽과 같은 것을 쓴다.
 * 같은 자를 써야 두 화면의 '우연일 확률'이 같은 뜻이 된다.
 */

import type { EnrichedBar } from "@/types";
import { binomTailGe } from "@/lib/cycle/evaluate";
import type { PatternBias, PatternDef, PatternSeries } from "./patterns";

/** 패턴 뒤를 들여다보는 지점 (거래일). 하루 / 1주 / 2주 / 1개월. */
export const CANDLE_HORIZONS = [1, 5, 10, 20] as const;
export type CandleHorizon = (typeof CANDLE_HORIZONS)[number];

export const HORIZON_LABEL: Record<number, string> = {
  1: "다음 날",
  5: "5거래일",
  10: "10거래일",
  20: "20거래일",
};

/** 기본 채점 구간. 캔들 패턴은 원래 며칠짜리 이야기라 1주(5거래일)를 기본으로 둔다. */
export const DEFAULT_HORIZON: CandleHorizon = 5;

export type ForwardStat = {
  n: number;
  avg: number | null;
  median: number | null;
  /** 상승 마감 비율(%). 방향과 무관한 날것. */
  upRate: number | null;
  best: number | null;
  worst: number | null;
};

/** 들고 가는 동안 반대로 밀린 폭. 값은 항상 0 이하 (0 = 한 번도 역행 없음). */
export type AdverseStat = {
  n: number;
  medianPct: number | null;
  worstPct: number | null;
};

export type HalfStat = {
  from: string;
  to: string;
  /** 그 기간 안의 패턴 발생 횟수. */
  count: number;
  successRate: number | null;
  baseRate: number | null;
  /** 그 기간의 기저 대비 평균 초과 수익(%p, 방향 반영). */
  edge: number | null;
};

export type WalkForward = {
  splitDate: string;
  early: HalfStat;
  late: HalfStat;
  /**
   * 앞 기간에서도 뒤 기간에서도 통했나.
   *
   * 20년을 한 덩어리로 재면, 2000년대에만 통하고 그 뒤로는 죽은 패턴이 여전히
   * 좋아 보인다. 반으로 갈라 양쪽 다 기저를 넘겼을 때만 통과로 본다.
   */
  heldUp: boolean;
};

export type PatternEvaluation = PatternDef & {
  /** 패턴이 완성된 날 전부. */
  occurrences: string[];
  count: number;
  /**
   * 서로 겹치지 않는 발생 횟수 (앞 발생으로부터 horizon 거래일 이상 떨어진 것만).
   *
   * 왜 따로 세는가: 적삼병은 사흘 연속 뜨는 일이 흔한데, 그 셋의 '다음 5일'은
   * 거의 같은 5일이다. 그걸 독립 시행 세 번으로 세면 표본이 실제보다 부풀고
   * 우연일 확률이 실제보다 낮게 나온다. 이항 검정의 n은 이 숫자를 쓴다.
   */
  independentCount: number;
  /** 방향이 맞은 날 (차트에 밝게 찍는다). */
  winDates: string[];
  /** 채점 구간에서 방향이 맞은 비율(%). */
  successRate: number | null;
  /** 같은 구간, 아무 날이나 골랐을 때의 방향 적중률(%). */
  baseRate: number | null;
  /** successRate − baseRate (%p). 이게 양수가 아니면 패턴이 있으나 마나다. */
  rateEdge: number | null;
  /** 채점 구간의 평균 수익률(%). 날것 — 하락형이면 음수가 정상이다. */
  avgMovePct: number | null;
  /** 같은 구간, 아무 날이나 골랐을 때의 평균 수익률(%). 위 숫자는 이것과 비교해야 뜻이 있다. */
  baseAvgMovePct: number | null;
  /** 방향을 곱한 평균 − 기저 평균 (%p). */
  edge: number | null;
  forward: Record<string, ForwardStat>;
  adverse: AdverseStat;
  baseAdverseMedianPct: number | null;
  chance: number | null;
  walkForward: WalkForward | null;
  lastDate: string | null;
  daysSinceLast: number | null;
  /** 마지막 봉에서 완성된 패턴인지. '지금 무엇이 떴나'가 여기서 나온다. */
  onLastBar: boolean;
  score: number;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function dirOf(bias: PatternBias): 1 | -1 {
  return bias === "상승" ? 1 : -1;
}

/**
 * 각 봉에서 n거래일 뒤까지의 종가 수익률(%). 끝부분은 미래가 없어 null.
 * 종가에 사서 종가에 파는 기준이다 (수수료·슬리피지는 넣지 않았다).
 */
export function forwardSeries(bars: EnrichedBar[], horizon: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = 0; i + horizon < bars.length; i++) {
    const base = bars[i].close;
    if (!(base > 0)) continue;
    out[i] = ((bars[i + horizon].close - base) / base) * 100;
  }
  return out;
}

function statsFrom(rets: number[]): ForwardStat {
  return {
    n: rets.length,
    avg: mean(rets),
    median: median(rets),
    upRate: rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : null,
    best: rets.length ? Math.max(...rets) : null,
    worst: rets.length ? Math.min(...rets) : null,
  };
}

function statsAt(bars: EnrichedBar[], indices: number[], horizon: number): ForwardStat {
  const fwd = forwardSeries(bars, horizon);
  const rets: number[] = [];
  for (const i of indices) {
    const r = fwd[i];
    if (r != null) rets.push(r);
  }
  return statsFrom(rets);
}

/**
 * 들고 가는 동안의 역행폭.
 *
 * 상승형이면 진입 다음 날부터 horizon까지의 최저 종가, 하락형이면 최고 종가를 본다.
 * "5일 뒤 +3%"라는 숫자는 그 사이 -7%를 견뎠어야 나온 것일 수 있다. 실제로 들고
 * 갈 수 있느냐는 이쪽에 달렸다. 값은 방향을 곱해 항상 0 이하로 만든다.
 */
export function adverseAfter(
  bars: EnrichedBar[],
  indices: number[],
  horizon: number,
  dir: 1 | -1,
): AdverseStat {
  const moves: number[] = [];
  for (const i of indices) {
    const base = bars[i].close;
    if (!(base > 0)) continue;
    const end = Math.min(bars.length - 1, i + horizon);
    if (end <= i) continue;
    let worst = 0;
    for (let j = i + 1; j <= end; j++) {
      const move = ((bars[j].close - base) / base) * 100 * dir;
      if (move < worst) worst = move;
    }
    moves.push(worst);
  }
  return { n: moves.length, medianPct: median(moves), worstPct: moves.length ? Math.min(...moves) : null };
}

/** 앞 발생으로부터 gap 거래일 이상 떨어진 것만 남긴다 (겹치는 표본 제거). */
export function independentIndices(indices: number[], gap: number): number[] {
  const out: number[] = [];
  for (const i of indices) {
    if (!out.length || i - out[out.length - 1] >= gap) out.push(i);
  }
  return out;
}

/**
 * 순환 이동 검정 (수익률 판).
 *
 * "이 패턴이 뜬 날들을 (개수도 간격도 그대로 둔 채) 통째로 아무 시점으로 옮겨도
 * 이만큼 벌었을까?"를 가능한 모든 이동에 대해 세어 본다.
 *
 * 이항 검정과 달리 발생이 몰려 있는 것(적삼병이 사흘 연속 뜨는 등)과 수익률의
 * 자기상관을 그대로 안고 간다. 관측값 자신(이동 0)도 후보에 넣어 p가 0이 되지 않게 한다.
 */
export function circularShiftReturnP(
  events: number[],
  fwd: (number | null)[],
  dir: 1 | -1,
): number | null {
  const n = fwd.length;
  if (!events.length || n <= 0) return null;

  const observedVals: number[] = [];
  for (const e of events) {
    const v = fwd[e];
    if (v != null) observedVals.push(v * dir);
  }
  const observed = mean(observedVals);
  if (observed == null) return null;

  const stride = Math.max(1, Math.ceil((n * events.length) / 2_000_000));
  let tried = 0;
  let atLeast = 0;
  for (let s = 0; s < n; s += stride) {
    let sum = 0;
    let cnt = 0;
    for (const e of events) {
      const j = e + s;
      const v = fwd[j >= n ? j - n : j];
      if (v != null) {
        sum += v * dir;
        cnt++;
      }
    }
    if (!cnt) continue;
    tried++;
    if (sum / cnt >= observed) atLeast++;
  }
  return tried ? atLeast / tried : null;
}

/** 한쪽 기간만 잘라서 다시 채점. 기저율도 그 기간 것으로 다시 잰다. */
function halfStat(
  bars: EnrichedBar[],
  lo: number,
  hi: number,
  events: number[],
  fwd: (number | null)[],
  dir: 1 | -1,
): HalfStat {
  const inHalf = events.filter((e) => e >= lo && e <= hi);
  const rets: number[] = [];
  for (const e of inHalf) {
    const v = fwd[e];
    if (v != null) rets.push(v);
  }
  const baseRets: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const v = fwd[i];
    if (v != null) baseRets.push(v);
  }

  const success = rets.length
    ? (rets.filter((r) => r * dir > 0).length / rets.length) * 100
    : null;
  const baseRate = baseRets.length
    ? (baseRets.filter((r) => r * dir > 0).length / baseRets.length) * 100
    : null;
  const avg = mean(rets);
  const baseAvg = mean(baseRets);

  return {
    from: bars[lo].date,
    to: bars[hi].date,
    count: inHalf.length,
    successRate: success,
    baseRate,
    edge: avg != null && baseAvg != null ? (avg - baseAvg) * dir : null,
  };
}

/** 앞뒤 기간 각각 이만큼은 떠야 성적을 비교할 수 있다고 본다. */
const MIN_HALF_EVENTS = 8;

/**
 * 순위에서 제값을 받으려면 필요한 (겹치지 않는) 발생 수.
 * 등급의 표본 관문(grade.ts의 MIN_SAMPLE)과 같은 숫자를 쓴다 — 같은 기준이어야
 * "표본이 모자라 관문에서 떨어진 패턴"이 순위에서도 아래에 있게 된다.
 */
const MIN_SAMPLE_FOR_RANK = 20;

export function walkForwardStats(
  bars: EnrichedBar[],
  events: number[],
  fwd: (number | null)[],
  dir: 1 | -1,
): WalkForward | null {
  if (bars.length < 200 || events.length < MIN_HALF_EVENTS * 2) return null;
  const splitIdx = Math.floor(bars.length / 2);
  const early = halfStat(bars, 0, splitIdx - 1, events, fwd, dir);
  const late = halfStat(bars, splitIdx, bars.length - 1, events, fwd, dir);
  const heldUp =
    early.count >= MIN_HALF_EVENTS &&
    late.count >= MIN_HALF_EVENTS &&
    early.edge != null &&
    late.edge != null &&
    early.edge > 0 &&
    late.edge > 0;
  return { splitDate: bars[splitIdx].date, early, late, heldUp };
}

export type CandleBaseline = {
  /** 아무 날이나 골랐을 때의 성적. 모든 비교의 기준선. */
  byHorizon: Record<string, ForwardStat>;
  /** 방향별 기저 역행폭 중앙값. 상승형은 낙폭, 하락형은 반등폭. */
  adverseUp: Record<string, number | null>;
  adverseDown: Record<string, number | null>;
};

export function baselineStats(bars: EnrichedBar[]): CandleBaseline {
  const all = bars.map((_, i) => i);
  const byHorizon: Record<string, ForwardStat> = {};
  const adverseUp: Record<string, number | null> = {};
  const adverseDown: Record<string, number | null> = {};
  for (const h of CANDLE_HORIZONS) {
    byHorizon[String(h)] = statsAt(bars, all, h);
    adverseUp[String(h)] = adverseAfter(bars, all, h, 1).medianPct;
    adverseDown[String(h)] = adverseAfter(bars, all, h, -1).medianPct;
  }
  return { byHorizon, adverseUp, adverseDown };
}

export type EvaluateOptions = {
  horizon?: CandleHorizon;
};

export function evaluatePattern(
  bars: EnrichedBar[],
  pattern: PatternSeries,
  baseline: CandleBaseline,
  opts: EvaluateOptions = {},
): PatternEvaluation {
  const horizon = opts.horizon ?? DEFAULT_HORIZON;
  const dir = dirOf(pattern.bias);
  const lastIdx = bars.length - 1;

  const events: number[] = [];
  for (let i = 0; i < bars.length; i++) if (pattern.at[i]) events.push(i);

  const fwd = forwardSeries(bars, horizon);
  const rets: number[] = [];
  const winDates: string[] = [];
  for (const e of events) {
    const v = fwd[e];
    if (v == null) continue;
    rets.push(v);
    if (v * dir > 0) winDates.push(bars[e].date);
  }

  const baseStat = baseline.byHorizon[String(horizon)];
  const baseRate =
    baseStat.upRate == null ? null : dir > 0 ? baseStat.upRate : 100 - baseStat.upRate;
  const successRate = rets.length
    ? (rets.filter((r) => r * dir > 0).length / rets.length) * 100
    : null;
  const avgMovePct = mean(rets);
  const edge =
    avgMovePct != null && baseStat.avg != null ? (avgMovePct - baseStat.avg) * dir : null;

  // 이항 검정의 n은 겹치지 않는 발생 수. 겹친 것까지 세면 표본이 부풀어
  // 우연일 확률이 실제보다 낮게(좋아 보이게) 나온다.
  const independent = independentIndices(events, horizon);
  const indepRets = independent.map((e) => fwd[e]).filter((v): v is number => v != null);
  const wins = indepRets.filter((r) => r * dir > 0).length;
  const binomP =
    indepRets.length && baseRate != null && baseRate > 0 && baseRate < 100
      ? binomTailGe(wins, indepRets.length, baseRate / 100)
      : null;
  const shiftP = circularShiftReturnP(events, fwd, dir);
  const chance =
    binomP == null && shiftP == null ? null : Math.max(binomP ?? 0, shiftP ?? 0);

  const forward: Record<string, ForwardStat> = {};
  for (const h of CANDLE_HORIZONS) forward[String(h)] = statsAt(bars, events, h);

  const adverse = adverseAfter(bars, events, horizon, dir);
  const baseAdverseMedianPct =
    (dir > 0 ? baseline.adverseUp : baseline.adverseDown)[String(horizon)] ?? null;

  const walkForward = walkForwardStats(bars, events, fwd, dir);
  const last = events.length ? events[events.length - 1] : null;

  // 순위 = 기저보다 얼마나 잘 맞혔나 + 얼마나 더 벌었나 + 그게 우연이 아닌가.
  //
  // 그리고 표본으로 통째로 깎는다. 더하기가 아니라 곱하기인 이유: 딱 한 번 떠서
  // 한 번 맞은 패턴은 적중률 100%·기저대비 +51%p가 찍혀서, 표본을 항목 하나로만
  // 넣으면 여전히 상위권에 올라온다. 그런 줄이 성적표 위쪽에 있으면 화면 전체를
  // 못 믿게 된다. 채점에 필요한 최소 표본에 못 미치면 그 비율만큼 순위가 눌린다.
  const rateDiff = successRate != null && baseRate != null ? successRate - baseRate : 0;
  const rateScore = Math.max(0, Math.min(1, rateDiff / 15)) * 100;
  const edgeScore = edge == null ? 0 : Math.max(0, Math.min(1, edge / 3)) * 100;
  const chanceScore = chance == null ? 0 : (1 - chance) * 100;
  const confidence = Math.min(1, independent.length / MIN_SAMPLE_FOR_RANK);
  const score = (rateScore * 0.35 + edgeScore * 0.3 + chanceScore * 0.35) * confidence;

  return {
    key: pattern.key,
    label: pattern.label,
    group: pattern.group,
    bias: pattern.bias,
    why: pattern.why,
    rule: pattern.rule,
    needsTrend: pattern.needsTrend,
    occurrences: events.map((i) => bars[i].date),
    count: events.length,
    independentCount: independent.length,
    winDates,
    successRate,
    baseRate,
    rateEdge: successRate != null && baseRate != null ? successRate - baseRate : null,
    avgMovePct,
    baseAvgMovePct: baseStat.avg,
    edge,
    forward,
    adverse,
    baseAdverseMedianPct,
    chance,
    walkForward,
    lastDate: last != null ? bars[last].date : null,
    daysSinceLast: last != null ? lastIdx - last : null,
    onLastBar: last === lastIdx,
    score,
  };
}
