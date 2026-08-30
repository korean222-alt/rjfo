/**
 * 지표 배터리 × 과거 상승장 시작점 = 성적표.
 *
 * 여기서 재는 것:
 *   적중률   — 과거 상승장 시작 N번 중, 그 부근에서 '새로 켜져서' 잡은 게 몇 번인가
 *              (하락장 내내 켜진 채로 바닥을 지나온 건 적중이 아니다)
 *   리드타임 — 실제 바닥보다 며칠 빨랐나/늦었나 (음수 = 선행)
 *   남은 상승 — 신호가 떴을 때 그 사이클 상승분의 몇 %가 아직 남아 있었나
 *   정확도   — 전체 신호 중 상승장 시작 부근이었던 비율 (오탐의 반대)
 *   기저율 대비 — 신호 이후 수익률 − 아무 날이나 골랐을 때의 수익률
 *   우연일 확률 — 아무 데나 같은 횟수만큼 찍어도 이만큼 맞을 확률 (이항 검정)
 *
 * 마지막 항목이 제일 중요하다. 원래 우상향인 자산은 아무 날이나 사도 승률이 높다.
 * 기저율을 안 빼면 모든 지표가 훌륭해 보인다.
 */

import type { EnrichedBar } from "@/types";
import type { Cycle } from "./regime";
import type { SignalDef, SignalSeries } from "./signals";

/** 전방 수익률을 재는 지점 (거래일). 대략 1·3·6·12개월. */
export const HORIZONS = [20, 60, 120, 250] as const;
export type Horizon = (typeof HORIZONS)[number];

export const HORIZON_LABELS: Record<Horizon, string> = {
  20: "1개월",
  60: "3개월",
  120: "6개월",
  250: "1년",
};

export type MatchWindow = {
  /** 바닥보다 이만큼 앞서 뜬 신호까지 인정 (거래일). */
  before: number;
  /** 바닥보다 이만큼 늦게 뜬 신호까지 인정 (거래일). */
  after: number;
};

/** 이 지표들은 대부분 '확인형'이라 바닥보다 늦게 뜬다. 뒤쪽 창을 넉넉히 잡는다. */
export const DEFAULT_WINDOW: MatchWindow = { before: 20, after: 150 };

/** 같은 신호가 며칠 안에 여러 번 깜빡이면 하나로 센다. */
const EVENT_CLUSTER_DAYS = 5;

export type ForwardStat = {
  n: number;
  avg: number | null;
  median: number | null;
  winRate: number | null;
};

export type CycleHit = {
  troughDate: string;
  eventDate: string | null;
  /** 신호일 − 바닥일 (거래일). 음수면 바닥보다 먼저 떴다. */
  leadDays: number | null;
  /** 신호 시점에 그 사이클 상승분의 몇 %가 남아 있었나. */
  captureSharePct: number | null;
  /**
   * 적중 여부. 창 안에서 '새로 켜진' 신호가 있어야 적중이다.
   * 바닥 한참 전에 켜져서 그냥 켜진 채로 지나온 건 적중이 아니다.
   */
  hit: boolean;
  /** 창 안에 새 신호는 없지만 바닥 당일 켜져는 있었다. 적중으로 세지 않는다. */
  alreadyOn: boolean;
};

export type SignalEvaluation = SignalDef & {
  events: string[];
  eventCount: number;
  /** 그 신호들 중 상승장 시작 부근(사이클 창)에서 뜬 것의 날짜. 정확도의 분자. */
  inWindowEvents: string[];
  cycleHits: CycleHit[];
  /** 창 안에서 '새로 켜져서' 잡은 사이클 수. 이미 켜져 있던 건 안 센다. */
  hitCount: number;
  hitRate: number | null;
  /**
   * 새 신호는 없었지만 바닥 당일 켜져는 있던 사이클 수.
   *
   * 적중에서 뺀 이유: 하락장 내내 켜진 채로 바닥을 지나온 지표도 '바닥에 켜져 있었다'가
   * 되어 버린다. 그렇게 세면 늘 켜져 있는 지표가 전부 적중률 100%로 나와서
   * 성적표 자체가 끼워 맞추기가 된다. 참고용으로 따로 보여준다.
   */
  alreadyOnCount: number;
  medianLeadDays: number | null;
  medianCaptureSharePct: number | null;
  falseAlarms: number;
  precision: number | null;
  /**
   * 우연 대비 배수. 정확도 ÷ (전체 기간 중 '상승장 시작 부근'이 차지하는 비율).
   *
   * 이게 없으면 하루 걸러 한 번씩 켜지는 지표가 1등이 된다. 그런 지표는 아무 사이클이나
   * 다 '적중'하지만 발견한 게 아무것도 없다. 1.0이면 아무 날이나 찍은 것과 같고,
   * 1.0 미만이면 오히려 상승장 시작을 덜 가리킨다.
   */
  lift: number | null;
  /**
   * 우연일 확률 (p-value). 0~1.
   *
   * lift만으로는 못 믿는다. 신호가 딱 2번 떴는데 둘 다 맞으면 lift는 하늘을 찌르지만
   * 동전 두 번 던져 앞면 두 번 나온 것과 다르지 않다. 표본 수를 같이 봐야 한다.
   *
   * 그래서 이렇게 묻는다: "아무 데나 eventCount번 찍는 가짜 지표가, 이 지표만큼
   * (또는 그보다 더) 상승장 시작 부근을 맞힐 확률은?" 두 가지로 재고 더 보수적인
   * (높은) 쪽을 쓴다.
   *
   *   1) 이항 검정 — 신호가 서로 무관하게 아무 날에나 떨어진다고 볼 때. B(n, windowShare).
   *   2) 순환 이동 검정 — 이 지표의 신호를 간격까지 그대로 둔 채 통째로 아무 시점으로
   *      옮겨봤을 때. 실제 신호는 몰려서 뜨는데(MACD가 며칠 간격으로 두 번 등)
   *      이항 검정은 그걸 독립으로 쳐서 확률을 실제보다 낮게 부른다.
   *
   * 0.05면 "우연히 이 정도가 나올 일이 20번에 한 번"이라는 뜻이다. 낮을수록 좋다.
   */
  chance: number | null;
  forward: Record<string, ForwardStat>;
  /** 1년 뒤 평균 수익률 − 기저율. 이게 음수면 신호가 있으나 마나다. */
  edge: number | null;
  currentlyOn: boolean | null;
  lastEventDate: string | null;
  daysSinceLastEvent: number | null;
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

function forwardReturnPct(bars: EnrichedBar[], i: number, n: number): number | null {
  const j = i + n;
  if (j >= bars.length) return null;
  const base = bars[i].close;
  if (!(base > 0)) return null;
  return ((bars[j].close - base) / base) * 100;
}

function statsAt(bars: EnrichedBar[], indices: number[], horizon: number): ForwardStat {
  const rets: number[] = [];
  for (const i of indices) {
    const r = forwardReturnPct(bars, i, horizon);
    if (r != null) rets.push(r);
  }
  return {
    n: rets.length,
    avg: mean(rets),
    median: median(rets),
    winRate: rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : null,
  };
}

/**
 * P(X ≥ k), X ~ 이항분포 B(n, p). 근사 없이 항을 다 더한다.
 *
 * 표본이 작을 때(사이클 5~7번, 신호 몇 번)가 정확히 이 앱의 상황이라, 정규근사를 쓰면
 * 확률이 눈에 띄게 틀어진다. n은 커봐야 수백이므로 그냥 정확히 계산하는 게 낫다.
 *
 * 각 항을 로그로 만들어 더한다. (1-p)^n 같은 값은 n이 조금만 커져도 0으로 언더플로하고,
 * 조합 C(n,i)는 반대로 오버플로한다. 로그 공간에서는 둘 다 일어나지 않는다.
 */
export function binomTailGe(k: number, n: number, p: number): number {
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(k)) return 1;
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;

  // 로그 팩토리얼 누적표.
  const logFact = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);

  const lp = Math.log(p);
  const lq = Math.log1p(-p);

  // 가장 큰 항을 빼고 더한 뒤 되돌린다 (log-sum-exp).
  const terms: number[] = [];
  let max = -Infinity;
  for (let i = Math.ceil(k); i <= n; i++) {
    const t = logFact[n] - logFact[i] - logFact[n - i] + i * lp + (n - i) * lq;
    terms.push(t);
    if (t > max) max = t;
  }
  if (!Number.isFinite(max)) return 0;

  let sum = 0;
  for (const t of terms) sum += Math.exp(t - max);
  return Math.min(1, Math.exp(max) * sum);
}

/** 상태 배열의 상승 엣지(꺼짐→켜짐)를 신호 발생일로 본다. 깜빡임은 묶는다. */
export function eventIndices(state: (boolean | null)[]): number[] {
  const out: number[] = [];
  let prev: boolean | null = null;
  for (let i = 0; i < state.length; i++) {
    const cur = state[i];
    if (cur == null) continue;
    if (prev === false && cur === true) {
      if (!out.length || i - out[out.length - 1] > EVENT_CLUSTER_DAYS) out.push(i);
    }
    prev = cur;
  }
  return out;
}

/**
 * 사이클마다 적중 창. 창끼리 겹치면 하루가 두 바닥에 속해 적중률이 부풀어 오르므로
 * 이웃 바닥 사이의 중점에서 자른다. 하루는 가장 가까운 바닥에만 속한다.
 */
export function exclusiveCycleBounds(
  cycles: Cycle[],
  barCount: number,
  win: MatchWindow = DEFAULT_WINDOW,
): { lo: number; hi: number }[] {
  return cycles.map((c, i) => {
    const rawLo = c.troughIdx - win.before;
    const rawHi = c.troughIdx + win.after;
    const prev = i > 0 ? cycles[i - 1].troughIdx : null;
    const next = i + 1 < cycles.length ? cycles[i + 1].troughIdx : null;
    const midLo = prev == null ? Number.NEGATIVE_INFINITY : Math.floor((prev + c.troughIdx) / 2) + 1;
    const midHi = next == null ? Number.POSITIVE_INFINITY : Math.floor((c.troughIdx + next) / 2);
    let lo = Math.max(0, rawLo, midLo);
    let hi = Math.min(barCount - 1, rawHi, midHi);
    if (lo > hi) {
      const pinned = Math.max(0, Math.min(barCount - 1, c.troughIdx));
      lo = pinned;
      hi = pinned;
    }
    return { lo, hi };
  });
}

/** 사이클 창을 하루 단위 마스크로. 정확도·우연일 확률이 같은 기준을 보게 하는 근거. */
export function windowMask(bounds: { lo: number; hi: number }[], barCount: number): Uint8Array {
  const mask = new Uint8Array(barCount);
  for (const b of bounds) {
    for (let i = Math.max(0, b.lo); i <= Math.min(barCount - 1, b.hi); i++) mask[i] = 1;
  }
  return mask;
}

/**
 * 순환 이동 검정.
 *
 * "이 지표의 신호를 (개수도 간격도 그대로 둔 채) 통째로 아무 시점으로 옮겨도
 * 이만큼 상승장 시작 부근에 떨어질까?" 를 가능한 모든 이동에 대해 세어 본다.
 *
 * 이항 검정과 달리 신호가 몰려 뜨는 걸 그대로 안고 간다. MACD 골든크로스처럼
 * 며칠 사이에 두 번 깜빡이는 지표는 실질 표본이 신호 횟수보다 적은데,
 * 이항 검정은 그걸 독립 시행으로 세어 확률을 실제보다 낮게(좋아 보이게) 부른다.
 *
 * 관측값 자신(이동 0)도 후보에 넣는다. 그래야 p가 0으로 떨어지지 않는다.
 */
export function circularShiftP(events: number[], mask: Uint8Array): number | null {
  const n = mask.length;
  if (!events.length || n <= 0) return null;
  let observed = 0;
  for (const e of events) if (mask[e]) observed++;

  // 이동 × 신호 = 계산량. 커지면 이동을 일정 간격으로 건너뛴다(결정론적).
  const stride = Math.max(1, Math.ceil((n * events.length) / 2_000_000));
  let tried = 0;
  let atLeast = 0;
  for (let s = 0; s < n; s += stride) {
    let c = 0;
    for (const e of events) {
      const j = e + s;
      if (mask[j >= n ? j - n : j]) c++;
    }
    tried++;
    if (c >= observed) atLeast++;
  }
  return tried ? atLeast / tried : null;
}

function lastAtOrBefore(events: number[], idx: number): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] <= idx) return events[i];
  }
  return null;
}

function firstInRange(events: number[], lo: number, hi: number): number | null {
  for (const e of events) {
    if (e >= lo && e <= hi) return e;
  }
  return null;
}

export type EvaluateOptions = {
  window?: MatchWindow;
};

export function evaluateSignal(
  bars: EnrichedBar[],
  signal: SignalSeries,
  cycles: Cycle[],
  baseline: Record<string, ForwardStat>,
  /** 전체 봉 중 '상승장 시작 부근'으로 인정되는 구간의 비율 (0~1). lift의 분모. */
  windowShare: number,
  opts: EvaluateOptions = {},
): SignalEvaluation {
  const win = opts.window ?? DEFAULT_WINDOW;
  const events = eventIndices(signal.state);
  const lastIdx = bars.length - 1;
  const bounds = exclusiveCycleBounds(cycles, bars.length, win);

  const mask = windowMask(bounds, bars.length);

  /**
   * 상승장 시작 부근에서 뜬 신호는 '전부' 센다.
   *
   * 예전에는 사이클마다 대표 신호 하나만 맞은 걸로 쳤다. 그러면 맞힌 신호 수가
   * 사이클 수(BTC면 11)를 절대 못 넘는데, 정확도의 분모인 신호 횟수는 수십~수백이다.
   * 자주 뜨는 지표는 창 안에서 세 번 떠도 두 번이 오탐으로 기록됐다.
   * 그 결과 정확도·우연대비는 실제보다 낮게, 우연일 확률은 실제보다 높게 나왔다
   * (신호가 26번 넘어가면 어떤 지표든 우연일 확률이 100%에 붙어 버린다).
   */
  const inWindowIdx = events.filter((e) => mask[e] === 1);

  const cycleHits: CycleHit[] = cycles.map((cycle, i) => {
    const { lo, hi } = bounds[i];
    const span = cycle.nextPeakClose - cycle.troughClose;
    const capture = (idx: number) =>
      span > 0 ? Math.max(0, ((cycle.nextPeakClose - bars[idx].close) / span) * 100) : null;

    // 1순위: 창 안에서 새로 켜진 첫 신호. 이게 진짜 '잡았다'이다.
    const fresh = firstInRange(events, lo, hi);
    if (fresh != null) {
      return {
        troughDate: cycle.troughDate,
        eventDate: bars[fresh].date,
        leadDays: fresh - cycle.troughIdx,
        captureSharePct: capture(fresh),
        hit: true,
        alreadyOn: false,
      };
    }

    // 새 신호는 없다. 바닥 당일 켜져는 있었나? 있었다면 참고로만 남긴다.
    if (signal.state[cycle.troughIdx] === true) {
      const prev = lastAtOrBefore(events, cycle.troughIdx);
      return {
        troughDate: cycle.troughDate,
        eventDate: prev != null ? bars[prev].date : null,
        leadDays: prev != null ? prev - cycle.troughIdx : null,
        captureSharePct: null,
        hit: false,
        alreadyOn: true,
      };
    }

    return {
      troughDate: cycle.troughDate,
      eventDate: null,
      leadDays: null,
      captureSharePct: null,
      hit: false,
      alreadyOn: false,
    };
  });

  const hits = cycleHits.filter((h) => h.hit);
  const alreadyOnCount = cycleHits.filter((h) => h.alreadyOn).length;
  const hitRate = cycles.length ? (hits.length / cycles.length) * 100 : null;
  const falseAlarms = events.length - inWindowIdx.length;
  const precision = events.length ? (inWindowIdx.length / events.length) * 100 : null;
  const lift = precision != null && windowShare > 0 ? precision / 100 / windowShare : null;
  const chance =
    events.length && windowShare > 0 && windowShare < 1
      ? Math.max(
          binomTailGe(inWindowIdx.length, events.length, windowShare),
          circularShiftP(events, mask) ?? 0,
        )
      : null;

  const forward: Record<string, ForwardStat> = {};
  for (const h of HORIZONS) forward[String(h)] = statsAt(bars, events, h);

  const edge =
    forward["250"].avg != null && baseline["250"].avg != null
      ? forward["250"].avg - baseline["250"].avg
      : null;

  const currentlyOn = signal.state[lastIdx] ?? null;
  const lastEvent = events.length ? events[events.length - 1] : null;

  const captureMedian = median(
    hits.map((h) => h.captureSharePct).filter((v): v is number => v != null),
  );

  // 순위 = 얼마나 잡았나(적중률) + 아무 날이나 찍은 것보다 나은가(우연대비) +
  // 그게 우연이 아닌가(우연일 확률) + 잡았을 때 먹을 게 남아 있었나(남은 상승).
  //
  // 우연일 확률을 넣는 이유: 적중률과 우연대비만 보면 표본이 적어 운으로 좋아 보이는
  // 지표가 위로 올라온다. 항상 켜져 있는 지표는 신호가 없어 셋 다 0점이 되어 저절로 밀린다.
  const liftScore = lift == null ? 0 : Math.min(1, lift / 3) * 100;
  const chanceScore = chance == null ? 0 : (1 - chance) * 100;
  const score =
    (hitRate ?? 0) * 0.35 + liftScore * 0.25 + chanceScore * 0.25 + (captureMedian ?? 0) * 0.15;

  return {
    key: signal.key,
    label: signal.label,
    group: signal.group,
    why: signal.why,
    timeframe: signal.timeframe,
    events: events.map((i) => bars[i].date),
    eventCount: events.length,
    inWindowEvents: inWindowIdx.map((i) => bars[i].date),
    cycleHits,
    hitCount: hits.length,
    hitRate,
    alreadyOnCount,
    medianLeadDays: median(hits.map((h) => h.leadDays).filter((v): v is number => v != null)),
    medianCaptureSharePct: captureMedian,
    falseAlarms,
    precision,
    lift,
    chance,
    forward,
    edge,
    currentlyOn,
    lastEventDate: lastEvent != null ? bars[lastEvent].date : null,
    daysSinceLastEvent: lastEvent != null ? lastIdx - lastEvent : null,
    score,
  };
}

export function baselineStats(bars: EnrichedBar[]): Record<string, ForwardStat> {
  const all = bars.map((_, i) => i);
  const out: Record<string, ForwardStat> = {};
  for (const h of HORIZONS) out[String(h)] = statsAt(bars, all, h);
  return out;
}

/**
 * 전체 봉 중 '상승장 시작 부근'(사이클 창)이 차지하는 비율.
 *
 * 창은 exclusiveCycleBounds로 이미 안 겹친다. 합집합 = 합.
 */
export function cycleWindowShare(
  barCount: number,
  cycles: Cycle[],
  win: MatchWindow = DEFAULT_WINDOW,
): number {
  if (barCount <= 0 || !cycles.length) return 0;
  const covered = windowMask(exclusiveCycleBounds(cycles, barCount, win), barCount);
  let n = 0;
  for (let i = 0; i < barCount; i++) n += covered[i];
  return n / barCount;
}

/**
 * 사이클 시작 시점에 몇 개의 지표가 켜져 있었는지.
 * "지난 상승장 시작 때는 21개가 켜져 있었는데 지금은 17개" 같은 비교를 만든다.
 * 바닥 당일이 아니라 offset 거래일 뒤에 재는 이유: 확인형 지표는 그때쯤 켜지기 때문.
 */
export function onCountAt(signals: SignalSeries[], idx: number): { on: number; total: number } {
  let on = 0;
  let total = 0;
  for (const s of signals) {
    const v = s.state[idx];
    if (v == null) continue;
    total++;
    if (v) on++;
  }
  return { on, total };
}
