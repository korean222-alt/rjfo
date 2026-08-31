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

/**
 * '상승장 시작 부근'이 전체 기간에서 차지할 수 있는 최대 비율.
 *
 * 이게 왜 필요한가 (하이닉스에서 실제로 터진 문제):
 *  사이클이 잦은 종목은 바닥이 17번씩 잡힌다. 바닥마다 170거래일씩 창을 주면
 *  창이 전체의 55~60%를 덮는다. 그러면 '상승장 시작 부근'이라는 라벨이 아무것도
 *  구분하지 못한다 — 우연대비(정확도 ÷ 창비율)의 천장이 1/0.58 = 1.7배로 눌려서,
 *  진짜 좋은 지표조차 관문 ②(1.5배)를 간신히 넘거나 못 넘는다. 반대로 사이클이
 *  적당히 잡힌 종목에서는 천장이 3~4배로 올라가 A등급이 쏟아진다.
 *  같은 모양의 합성 시세로 주기만 바꿔 재보면 A등급이 0개 → 55개 → 5개로 요동친다.
 *  종목의 우열이 아니라 사이클 밀도가 등급을 결정해 버리는 것이다.
 *
 *  그래서 창이 이 비율을 넘으면 뒤쪽 창(after)을 줄여 한도에 맞춘다. 창이 짧아지면
 *  '늦게 뜬 확인형 지표'는 적중에서 빠지지만, 그건 사실을 반영하는 쪽이다 —
 *  바닥 7개월 뒤에 켜지는 신호를 '상승장 시작을 잡았다'고 부를 수는 없다.
 */
export const MAX_WINDOW_SHARE = 0.35;

/** 같은 신호가 며칠 안에 여러 번 깜빡이면 하나로 센다. */
const EVENT_CLUSTER_DAYS = 5;

export type ForwardStat = {
  n: number;
  avg: number | null;
  median: number | null;
  winRate: number | null;
  /** 가장 나빴던 한 번. 평균만 보면 "한 번은 -70%였다"가 안 보인다. */
  worst: number | null;
};

/** 신호 뒤에 얼마나 물렸나. 사도 되는지를 가르는 건 평균 수익이 아니라 이쪽이다. */
export type DrawdownStat = {
  n: number;
  /** 신호 다음 날부터 기간 안에 찍은 최저 종가까지의 낙폭(%). 중앙값. */
  medianPct: number | null;
  /** 그중 가장 깊었던 것. */
  worstPct: number | null;
};

/** 기간을 반으로 갈라 본 성적. 한쪽에서만 좋으면 그건 발견이 아니라 우연이다. */
export type HalfStat = {
  from: string;
  to: string;
  cycles: number;
  hits: number;
  events: number;
  inWindow: number;
  /** 그 기간 안에서 '상승장 시작 부근'이 차지하는 비율 (0~1). */
  windowShare: number;
  lift: number | null;
};

export type WalkForward = {
  splitDate: string;
  early: HalfStat;
  late: HalfStat;
  /**
   * 앞 기간에서도 뒤 기간에서도 통했나.
   *
   * 과거 전체를 한 덩어리로 채점하면, 옛날 한 번의 대박으로 평균이 끌어올려진 지표와
   * 꾸준히 통한 지표가 구별되지 않는다. 반으로 갈라 양쪽 다 우연대비 1배를 넘고
   * 뒤 기간 사이클도 잡았을 때만 통과로 본다.
   */
  heldUp: boolean;
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
  /** 신호 후 1년 안에 얼마나 물렸나. */
  drawdown: DrawdownStat;
  /** 1년 뒤 평균 수익률 − 기저율. 이게 음수면 신호가 있으나 마나다. */
  edge: number | null;
  /** 신호가 바닥보다 먼저 떴나(선행), 바닥권이었나(동행), 늦었나(후행). */
  timing: "선행" | "동행" | "후행" | null;
  /** 기간을 반으로 갈라 본 성적. 사이클이 2개 미만이면 못 잰다. */
  walkForward: WalkForward | null;
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
    worst: rets.length ? Math.min(...rets) : null,
  };
}

/**
 * 신호 다음 날부터 horizon 거래일 안의 최대 낙폭.
 *
 * "1년 뒤 +80%"라는 숫자는 그 사이에 -55%를 견뎠어야 나온 것일 수 있다.
 * 실제로 들고 갈 수 있느냐는 그쪽에 달렸으므로 따로 잰다.
 */
export function drawdownAfter(
  bars: EnrichedBar[],
  indices: number[],
  horizon: number,
): DrawdownStat {
  const dds: number[] = [];
  for (const i of indices) {
    const base = bars[i].close;
    if (!(base > 0)) continue;
    const end = Math.min(bars.length - 1, i + horizon);
    if (end <= i) continue;
    let low = Infinity;
    for (let j = i + 1; j <= end; j++) low = Math.min(low, bars[j].close);
    if (!Number.isFinite(low)) continue;
    dds.push(Math.min(0, (low / base - 1) * 100));
  }
  return {
    n: dds.length,
    medianPct: median(dds),
    worstPct: dds.length ? Math.min(...dds) : null,
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
    // 고점에서도 자른다. 다음 고점을 지난 날은 정의상 '상승장 시작 부근'이 아니라
    // 이미 하락 국면이고, 직전 고점 이전은 앞 사이클의 상승 구간이다.
    const peakLo = c.peakIdx == null ? Number.NEGATIVE_INFINITY : c.peakIdx;
    const peakHi = c.nextPeakIdx == null ? Number.POSITIVE_INFINITY : c.nextPeakIdx;
    let lo = Math.max(0, rawLo, midLo, peakLo);
    let hi = Math.min(barCount - 1, rawHi, midHi, peakHi);
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

/**
 * 리드타임을 사람 말로 한 단계.
 *
 * 바닥을 미리 맞히는 지표는 사실상 없다. 그래도 '바닥 즈음'과 '한참 뒤'는 전혀 다른
 * 물건이라, 실제로 매수 타이밍에 쓸 수 있는지를 이 한 단어로 구분한다.
 */
export function timingOf(medianLeadDays: number | null): "선행" | "동행" | "후행" | null {
  if (medianLeadDays == null) return null;
  if (medianLeadDays <= -5) return "선행";
  if (medianLeadDays <= 20) return "동행";
  return "후행";
}

/** 한쪽 기간만 잘라서 다시 채점. windowShare도 그 기간 기준으로 다시 잰다. */
function halfStat(
  bars: EnrichedBar[],
  lo: number,
  hi: number,
  cycles: Cycle[],
  cycleHits: CycleHit[],
  events: number[],
  mask: Uint8Array,
): HalfStat {
  let covered = 0;
  for (let i = lo; i <= hi; i++) covered += mask[i];
  const span = hi - lo + 1;
  const share = span > 0 ? covered / span : 0;

  const inHalf = cycles.map((c) => c.troughIdx >= lo && c.troughIdx <= hi);
  const ev = events.filter((e) => e >= lo && e <= hi);
  const inWindow = ev.filter((e) => mask[e] === 1).length;
  const precision = ev.length ? inWindow / ev.length : null;

  return {
    from: bars[lo].date,
    to: bars[hi].date,
    cycles: inHalf.filter(Boolean).length,
    hits: cycleHits.filter((h, i) => inHalf[i] && h.hit).length,
    events: ev.length,
    inWindow,
    windowShare: share,
    lift: precision != null && share > 0 ? precision / share : null,
  };
}

/**
 * 사이클 목록의 가운데 바닥을 기준으로 기간을 두 동강 낸다.
 * 바닥에서 자르는 이유: 한 사이클이 두 기간에 걸치면 양쪽 다 반쪽 성적이 나온다.
 */
export function walkForwardStats(
  bars: EnrichedBar[],
  cycles: Cycle[],
  cycleHits: CycleHit[],
  events: number[],
  mask: Uint8Array,
): WalkForward | null {
  if (cycles.length < 2 || bars.length < 4) return null;
  const splitIdx = cycles[Math.floor(cycles.length / 2)].troughIdx;
  if (splitIdx <= 0 || splitIdx >= bars.length - 1) return null;

  const early = halfStat(bars, 0, splitIdx - 1, cycles, cycleHits, events, mask);
  const late = halfStat(bars, splitIdx, bars.length - 1, cycles, cycleHits, events, mask);
  const heldUp =
    early.cycles > 0 &&
    late.cycles > 0 &&
    late.hits > 0 &&
    early.lift != null &&
    late.lift != null &&
    early.lift >= 1 &&
    late.lift >= 1;

  return { splitDate: bars[splitIdx].date, early, late, heldUp };
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
  const drawdown = drawdownAfter(bars, events, 250);

  const edge =
    forward["250"].avg != null && baseline["250"].avg != null
      ? forward["250"].avg - baseline["250"].avg
      : null;

  const currentlyOn = signal.state[lastIdx] ?? null;
  const lastEvent = events.length ? events[events.length - 1] : null;

  const captureMedian = median(
    hits.map((h) => h.captureSharePct).filter((v): v is number => v != null),
  );
  const medianLeadDays = median(
    hits.map((h) => h.leadDays).filter((v): v is number => v != null),
  );
  const walkForward = walkForwardStats(bars, cycles, cycleHits, events, mask);

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
    medianLeadDays,
    medianCaptureSharePct: captureMedian,
    falseAlarms,
    precision,
    lift,
    chance,
    forward,
    drawdown,
    edge,
    timing: timingOf(medianLeadDays),
    walkForward,
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

export type ResolvedWindow = {
  window: MatchWindow;
  /** 창이 덮은 봉의 비율 (0~1). */
  share: number;
  /** 요청받은 창(보통 DEFAULT_WINDOW). 줄어들었는지 비교용. */
  requested: MatchWindow;
  /** 한도(MAX_WINDOW_SHARE)를 넘어 뒤쪽 창을 줄였는지. */
  shrunk: boolean;
};

/**
 * 창 비율이 한도를 넘으면 뒤쪽 창을 줄여서 맞춘다.
 *
 * after를 이분탐색으로 줄인다. 창을 줄이면 커버리지는 단조 감소하므로 이분탐색이
 * 성립한다. 최소 20거래일은 남긴다 — 그보다 짧으면 '바닥 부근'이라는 개념 자체가
 * 사라져서, 어떤 확인형 지표도 잡을 수 없는 창이 된다(그럴 땐 줄이기를 포기하고
 * 한도 초과 사실을 경고로 알린다).
 */
export function resolveWindow(
  barCount: number,
  cycles: Cycle[],
  requested: MatchWindow = DEFAULT_WINDOW,
  maxShare: number = MAX_WINDOW_SHARE,
): ResolvedWindow {
  const shareOf = (win: MatchWindow) => cycleWindowShare(barCount, cycles, win);
  const asked = shareOf(requested);
  if (!cycles.length || asked <= maxShare) {
    return { window: requested, share: asked, requested, shrunk: false };
  }

  const MIN_AFTER = 20;
  let lo = MIN_AFTER;
  let hi = requested.after;
  let best = MIN_AFTER;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (shareOf({ ...requested, after: mid }) <= maxShare) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const window = { ...requested, after: best };
  return { window, share: shareOf(window), requested, shrunk: true };
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
