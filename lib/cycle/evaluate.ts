/**
 * 지표 배터리 × 과거 상승장 시작점 = 성적표.
 *
 * 여기서 재는 것:
 *   적중률   — 과거 상승장 시작 N번 중 몇 번을 잡았나
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
};

export type SignalEvaluation = SignalDef & {
  events: string[];
  eventCount: number;
  cycleHits: CycleHit[];
  hitCount: number;
  hitRate: number | null;
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
   * (또는 그보다 더) 상승장 시작 부근을 맞힐 확률은?" 각 신호가 전체 기간에 고르게
   * 떨어진다고 보면 상승장 시작 부근에 떨어질 확률이 windowShare이므로,
   * 이항분포 B(eventCount, windowShare)의 꼬리 확률이 그 답이다.
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

  const matchedEvents = new Set<number>();
  const cycleHits: CycleHit[] = cycles.map((cycle) => {
    const lo = cycle.troughIdx - win.before;
    const hi = cycle.troughIdx + win.after;
    // 창 안에서 가장 먼저 뜬 신호를 그 사이클의 대표로 삼는다.
    const hit = events.find((e) => e >= lo && e <= hi);
    if (hit == null) {
      return { troughDate: cycle.troughDate, eventDate: null, leadDays: null, captureSharePct: null };
    }
    matchedEvents.add(hit);

    const span = cycle.nextPeakClose - cycle.troughClose;
    const remaining = cycle.nextPeakClose - bars[hit].close;
    return {
      troughDate: cycle.troughDate,
      eventDate: bars[hit].date,
      leadDays: hit - cycle.troughIdx,
      captureSharePct: span > 0 ? Math.max(0, (remaining / span) * 100) : null,
    };
  });

  const hits = cycleHits.filter((h) => h.eventDate != null);
  const hitRate = cycles.length ? (hits.length / cycles.length) * 100 : null;
  const falseAlarms = events.length - matchedEvents.size;
  const precision = events.length ? (matchedEvents.size / events.length) * 100 : null;
  const lift = precision != null && windowShare > 0 ? precision / 100 / windowShare : null;
  const chance =
    events.length && windowShare > 0 && windowShare < 1
      ? binomTailGe(matchedEvents.size, events.length, windowShare)
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

  // 세 축의 가중합.
  //
  // 정확도를 그대로 쓰지 않고 lift를 쓰는 게 중요하다. 자주 켜지는 지표는 정확도가
  // 낮아도 사이클을 전부 '적중'하므로, 정확도만으로는 충분히 벌하지 못한다.
  // lift는 "아무 날이나 찍었을 때보다 나은가"를 직접 재기 때문에 노이즈 지표를 걸러낸다.
  // 3배 이상이면 만점으로 본다 (표본이 적어 그 위는 변별력이 없다).
  const liftScore = lift == null ? 0 : Math.min(1, lift / 3) * 100;
  const score = (hitRate ?? 0) * 0.4 + liftScore * 0.35 + (captureMedian ?? 0) * 0.25;

  return {
    key: signal.key,
    label: signal.label,
    group: signal.group,
    why: signal.why,
    timeframe: signal.timeframe,
    events: events.map((i) => bars[i].date),
    eventCount: events.length,
    cycleHits,
    hitCount: hits.length,
    hitRate,
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
 * 창끼리 겹칠 수 있어서 합집합으로 센다. 겹친 걸 두 번 세면 분모가 부풀어
 * 모든 지표의 lift가 실제보다 낮게 나온다.
 */
export function cycleWindowShare(
  barCount: number,
  cycles: Cycle[],
  win: MatchWindow = DEFAULT_WINDOW,
): number {
  if (barCount <= 0 || !cycles.length) return 0;
  const covered = new Uint8Array(barCount);
  for (const c of cycles) {
    const lo = Math.max(0, c.troughIdx - win.before);
    const hi = Math.min(barCount - 1, c.troughIdx + win.after);
    for (let i = lo; i <= hi; i++) covered[i] = 1;
  }
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
