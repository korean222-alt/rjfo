/**
 * 조합 신호 — "이 둘이 동시에 켜지면".
 *
 * 사람이 실제로 쓰는 매수 규칙은 지표 하나가 아니다. "365일선을 넘고, 주봉 MACD가
 * 골든크로스면 산다"처럼 추세 확인 하나에 모멘텀 전환 하나를 겹친다. 겹치면 신호 수가
 * 줄어드는 대신 헛신호가 걸러진다 — 일봉 MACD처럼 120번 뜨는 지표도, 다른 조건과
 * 겹치면 몇 번으로 준다.
 *
 * 조합의 신호일은 '늦게 켜진 쪽이 켜진 날'이다(둘 다 켜진 첫날). 그래서 조합은 구성
 * 지표보다 항상 같거나 늦게 뜬다. 대신 잘 안 속는다 — 그 맞바꿈을 성적표로 보여준다.
 *
 * 주의: 조합을 수십 개 만들어 그중 제일 좋은 걸 고르는 건 그 자체가 끼워 맞추기다.
 * 그래서 ① 아무 쌍이나 만들지 않고(같은 성격끼리는 겹쳐도 새로울 게 없다) ② 만들어진
 * 조합을 단일 지표와 같은 다중검정 보정 풀에 넣는다. 골라낸 개수만큼 기준이 엄해진다.
 */

import type { EnrichedBar } from "@/types";
import type { Cycle } from "./regime";
import type { SignalSeries } from "./signals";
import {
  evaluateSignal,
  type EvaluateOptions,
  type ForwardStat,
  type SignalEvaluation,
} from "./evaluate";

/** 조합에 쓸 후보 수. 늘릴수록 쌍이 제곱으로 늘고, 늘어난 만큼 보정이 엄해진다. */
const TOP_N = 10;

const TF_RANK: Record<SignalSeries["timeframe"], number> = { 일봉: 0, 주봉: 1, 월봉: 2 };

export const COMBO_PREFIX = "combo:";

export function isCombo(key: string): boolean {
  return key.startsWith(COMBO_PREFIX);
}

/** 둘 다 켜져 있어야 켜짐. 한쪽이라도 값이 없으면(워밍업 구간) 값 없음. */
export function andState(a: (boolean | null)[], b: (boolean | null)[]): (boolean | null)[] {
  return a.map((v, i) => (v == null || b[i] == null ? null : v && b[i]!));
}

function pairSeries(a: SignalSeries, b: SignalSeries): SignalSeries {
  return {
    key: `${COMBO_PREFIX}${a.key}+${b.key}`,
    label: `${a.label} + ${b.label}`,
    group: a.group,
    why: `${a.label}가 켜져 있고 ${b.label}도 켜진 상태. 신호일은 둘 다 켜진 첫날입니다.`,
    // 느린 쪽 봉을 따른다. 주봉 조건이 끼면 그 조합은 주 단위로만 바뀐다.
    timeframe: TF_RANK[a.timeframe] >= TF_RANK[b.timeframe] ? a.timeframe : b.timeframe,
    state: andState(a.state, b.state),
  };
}

export type ComboEvaluation = SignalEvaluation & {
  /** 구성 지표의 key 두 개. 차트·설명에서 되짚어 갈 때 쓴다. */
  members: [string, string];
};

/**
 * 상위 지표들을 서로 다른 성격끼리 짝지어 채점한다.
 *
 * 같은 그룹끼리는 짝짓지 않는다. 50일선과 120일선을 겹치는 건 사실상 같은 조건을
 * 두 번 거는 것이라, 신호만 줄고 새로 알게 되는 건 없다.
 */
export function buildCombos(
  bars: EnrichedBar[],
  signals: SignalSeries[],
  ranked: SignalEvaluation[],
  cycles: Cycle[],
  baseline: Record<string, ForwardStat>,
  windowShare: number,
  opts: EvaluateOptions = {},
): ComboEvaluation[] {
  const byKey = new Map(signals.map((s) => [s.key, s]));
  const top = ranked
    .slice(0, TOP_N)
    .map((r) => byKey.get(r.key))
    .filter((s): s is SignalSeries => s != null);

  const out: ComboEvaluation[] = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      if (top[i].group === top[j].group) continue;
      const pair = pairSeries(top[i], top[j]);
      // 한 번도 안 켜지는 조합은 성적표에 올릴 게 없다.
      if (!pair.state.some((v) => v === true)) continue;
      const evaluated = evaluateSignal(bars, pair, cycles, baseline, windowShare, opts);
      if (!evaluated.eventCount) continue;
      out.push({ ...evaluated, members: [top[i].key, top[j].key] });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
