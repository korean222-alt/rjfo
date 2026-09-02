/**
 * "지금 어디쯤인가" — 이 배터리의 가장 큰 구멍을 메우는 계산.
 *
 * 문제가 뭐였나.
 *   등급표의 숫자(적중률·리드타임·남은 상승·1년 수익률·낙폭)는 전부 신호가 '켜지는 그 날'
 *   기준으로 잰 것이다(evaluate.ts는 eventIndices, 즉 상태의 상승 엣지에서만 잰다).
 *   그런데 화면은 currentlyOn — '지금 켜져 있는가'라는 상태 — 로 그 지표를 보여준다.
 *   둘은 다른 물건이다. 400거래일 전에 켜져서 아직 켜져 있는 200일선은 A등급 자격을
 *   전부 갖췄지만, 그 A등급의 근거는 오늘 사는 사람에게 하나도 적용되지 않는다.
 *   "이미 많이 올라서 A급이 다 켜졌다"는 상태는 등급표에서 좋아 보이는 상태와 구별이
 *   안 됐다. 그래서 여기서 셋을 따로 잰다.
 *
 *   ① 사이클 진행도 — 지금 상승분이 과거 사이클 상승폭 중앙값의 몇 %인가.
 *   ② 신호 나이     — 켜진 지 며칠인가. 등급표를 잰 창 안에 아직 있는가.
 *   ③ 반납폭(giveback) — 이게 핵심이다. 켜져 있는 동안의 최고가 대비 지금 몇 %인가,
 *      그리고 과거에 이 지표가 '꺼졌을 때'는 최고가 대비 몇 %에서 꺼졌나.
 *
 * ③이 "A급 지표가 꺼질 때까지 들고 있으면 큰일 난다"는 걱정에 숫자로 답한다.
 * 지표가 꺼지길 기다리는 매도 규칙의 값이 얼마인지를 과거로 직접 재기 때문이다.
 * 예: 200일선은 과거에 켜진 동안 최고가 대비 중앙값 −31%에서 꺼졌다. 지금은 −8%다.
 *     → 그 규칙을 쓰면 여기서 −25%를 더 반납하고 나오게 된다.
 *
 * 여기에는 새로운 통계 주장이 없다. 미래 수익률을 예측하지도, 매도 신호를 만들지도
 * 않는다. 이미 있는 상태 배열과 사이클 라벨에서 기술 통계만 뽑는다. 표본은 여전히
 * 사이클 몇 번뿐이므로 중앙값은 '대략 이 정도였다'는 뜻 이상이 아니다.
 */

import type { EnrichedBar } from "@/types";
import type { Grade } from "./grade";
import type { Cycle, CycleThresholds } from "./regime";

/** 상태가 연속으로 켜져 있던 구간. end가 null이면 아직 켜져 있다. */
export type OnRun = {
  /** 켜진 첫날 (상승 엣지). */
  start: number;
  /** 켜져 있던 마지막 날. 아직 켜져 있으면 null. */
  end: number | null;
};

/**
 * 상태 배열을 '켜져 있던 구간'들로 자른다.
 *
 * 왼쪽이 잘린 구간(데이터 시작부터 이미 켜져 있던 것)은 버린다. 언제 켜졌는지 모르면
 * '켜져 있는 동안의 최고가'가 실제보다 낮게 나와 반납폭이 과소평가된다.
 * null(워밍업)은 값이 없는 것이지 꺼진 게 아니므로 건너뛴다 — eventIndices와 같은 규칙.
 */
export function onRuns(state: (boolean | null)[]): OnRun[] {
  const runs: OnRun[] = [];
  let prev: boolean | null = null;
  let open: number | null = null;

  for (let i = 0; i < state.length; i++) {
    const cur = state[i];
    if (cur == null) continue;
    if (prev === false && cur === true) open = i;
    if (prev === true && cur === false && open != null) {
      runs.push({ start: open, end: i - 1 });
      open = null;
    }
    prev = cur;
  }
  if (open != null) runs.push({ start: open, end: null });
  return runs;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** a 대비 b가 몇 %인가. 둘 다 양수일 때만. */
function pctChange(from: number, to: number): number | null {
  return from > 0 ? ((to - from) / from) * 100 : null;
}

/** 구간 안의 최고 종가와 그 날짜. */
function peakIn(bars: EnrichedBar[], lo: number, hi: number): { idx: number; close: number } {
  let idx = lo;
  for (let i = lo; i <= hi; i++) if (bars[i].close > bars[idx].close) idx = i;
  return { idx, close: bars[idx].close };
}

export type OnSignalPosition = {
  key: string;
  label: string;
  grade: Grade;
  /** 켜진 날 (현재 구간의 시작). */
  onSinceDate: string;
  /** 켜진 지 며칠 (거래일). */
  daysOn: number;
  /**
   * 등급표를 잰 창(바닥 + window.after 거래일) 안에 아직 있는가.
   * false면 등급표의 숫자는 오늘 진입에 적용되지 않는다.
   */
  fresh: boolean;
  /** 켜진 뒤 최고 종가일. */
  peakSinceOnDate: string;
  /** 켜진 뒤 최고 종가 대비 현재 종가 (%, 0 이하). 지금까지 반납한 몫. */
  givebackNowPct: number | null;
  /**
   * 과거에 이 지표가 꺼졌을 때, 켜져 있던 동안 최고가 대비 몇 %에서 꺼졌나. 중앙값.
   * 항상 0 이하. 이 지표를 매도 규칙으로 쓸 때 실제로 반납하게 되는 몫이다.
   */
  medianExitGivebackPct: number | null;
  /** 그중 가장 깊었던 것. */
  worstExitGivebackPct: number | null;
  /** 중앙값을 만든 표본 수(= 과거에 켜졌다 꺼진 횟수). */
  exitSamples: number;
  /**
   * 과거 중앙값만큼 반납하려면 오늘 종가에서 추가로 몇 % 더 빠져야 하나 (보통 음수).
   * 양수면 이미 과거 중앙값보다 더 반납했는데도 아직 안 꺼졌다는 뜻이다.
   */
  furtherDropToExitPct: number | null;
};

export type CyclePosition = {
  /** 진행 중인 사이클의 바닥. 하락 국면이면 직전 사이클의 바닥. */
  troughDate: string | null;
  /** 진행 중인 사이클인가 (= 고점이 아직 확정되지 않았나). */
  ongoing: boolean;
  /** 바닥 대비 현재 상승률. */
  gainPct: number | null;
  /** 이 사이클의 최고 종가일. */
  peakDate: string | null;
  /** 바닥 → 그 최고 종가 상승률. */
  peakGainPct: number | null;
  /** 그 최고 종가 대비 현재 (%, 0 이하). */
  fromPeakPct: number | null;
  /**
   * 국면이 '하락'으로 뒤집히기까지(고점 대비 −bearPct) 오늘 종가에서 추가로 필요한 하락 (%, 음수).
   * 이미 하락 국면이면 null.
   */
  furtherDropToBearPct: number | null;
  /** 끝난 과거 사이클들의 상승폭 (%). */
  pastGains: number[];
  medianPastGainPct: number | null;
  /** 지금 상승률 ÷ 과거 중앙값 × 100. 소진율. */
  progressPct: number | null;
  /** 과거 완료 사이클 중 지금 상승률이 이미 넘어선 개수. */
  exceededCount: number;
};

export type PositionStage =
  | "하락 국면"
  | "고점권 되밀림"
  | "초기"
  | "중반"
  | "과거 중앙값 초과"
  | "판정불가";

export type PositionAssessment = {
  stage: PositionStage;
  cycle: CyclePosition;
  /** 지금 켜져 있는 지표들. 등급 좋은 순. */
  onSignals: OnSignalPosition[];
  /** 그중 등급표 창 안에 아직 있는 것 / 벗어난 것. */
  freshCount: number;
  staleCount: number;
  /** 켜진 A·B등급이 꺼지기까지 필요한 추가 하락의 중앙값 (%, 음수). */
  medianFurtherDropToExitPct: number | null;
  notes: string[];
};

const GRADE_RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3 };

export type PositionInput = {
  key: string;
  label: string;
  grade: Grade;
  score: number;
  state: (boolean | null)[];
};

/**
 * 지금 위치를 잰다.
 *
 * @param windowAfter 등급표가 '상승장 시작 부근'으로 인정한 뒤쪽 창(거래일).
 *                    켜진 지 이보다 오래된 지표는 등급표 밖에 있다.
 */
export function assessPosition(
  bars: EnrichedBar[],
  cycles: Cycle[],
  candidates: PositionInput[],
  thresholds: CycleThresholds,
  windowAfter: number,
): PositionAssessment {
  const lastIdx = bars.length - 1;
  const notes: string[] = [];

  if (lastIdx < 0) {
    return {
      stage: "판정불가",
      cycle: {
        troughDate: null,
        ongoing: false,
        gainPct: null,
        peakDate: null,
        peakGainPct: null,
        fromPeakPct: null,
        furtherDropToBearPct: null,
        pastGains: [],
        medianPastGainPct: null,
        progressPct: null,
        exceededCount: 0,
      },
      onSignals: [],
      freshCount: 0,
      staleCount: 0,
      medianFurtherDropToExitPct: null,
      notes: ["데이터가 없습니다."],
    };
  }

  const now = bars[lastIdx].close;

  // ── ① 사이클 진행도 ───────────────────────────────────────────────
  const last = cycles.length ? cycles[cycles.length - 1] : null;
  const ongoing = last != null && !last.closed;
  const pastGains = cycles.filter((c) => c.closed).map((c) => c.gainPct);
  const medianPastGainPct = median(pastGains);

  let cyclePos: CyclePosition = {
    troughDate: last?.troughDate ?? null,
    ongoing,
    gainPct: null,
    peakDate: null,
    peakGainPct: null,
    fromPeakPct: null,
    furtherDropToBearPct: null,
    pastGains,
    medianPastGainPct,
    progressPct: null,
    exceededCount: 0,
  };

  if (last) {
    // 진행 중이면 바닥 이후 지금까지, 끝난 사이클이면 바닥 → 확정된 고점.
    const hi = ongoing ? lastIdx : (last.nextPeakIdx ?? lastIdx);
    const peak = peakIn(bars, last.troughIdx, Math.max(last.troughIdx, hi));
    const gainPct = pctChange(last.troughClose, now);
    const fromPeakPct = pctChange(peak.close, now);
    const bearLine = peak.close * (1 - thresholds.bearPct / 100);

    cyclePos = {
      ...cyclePos,
      gainPct,
      peakDate: bars[peak.idx].date,
      peakGainPct: pctChange(last.troughClose, peak.close),
      fromPeakPct: fromPeakPct == null ? null : Math.min(0, fromPeakPct),
      // 이미 하락 국면(사이클이 닫힘)이면 뒤집힐 게 없다.
      furtherDropToBearPct: ongoing ? pctChange(now, bearLine) : null,
      progressPct:
        gainPct != null && medianPastGainPct != null && medianPastGainPct > 0
          ? (gainPct / medianPastGainPct) * 100
          : null,
      exceededCount: gainPct == null ? 0 : pastGains.filter((g) => g < gainPct).length,
    };
  }

  // ── ②③ 켜진 지표의 나이와 반납폭 ────────────────────────────────
  const onSignals: OnSignalPosition[] = [];
  for (const c of candidates) {
    if (c.state[lastIdx] !== true) continue;
    const runs = onRuns(c.state);
    const current = runs.find((r) => r.end == null);
    if (!current) continue; // 왼쪽이 잘린 구간 — 언제 켜졌는지 모르므로 재지 않는다.

    const peak = peakIn(bars, current.start, lastIdx);
    const givebackNowPct = pctChange(peak.close, now);

    // 과거에 꺼졌던 구간들의 반납폭. 꺼진 날의 종가로 나왔다고 본다.
    const exits: number[] = [];
    for (const r of runs) {
      if (r.end == null) continue;
      const p = peakIn(bars, r.start, r.end);
      const exitIdx = Math.min(lastIdx, r.end + 1);
      const g = pctChange(p.close, bars[exitIdx].close);
      if (g != null) exits.push(Math.min(0, g));
    }
    const medianExit = median(exits);
    const nowGiveback = givebackNowPct == null ? null : Math.min(0, givebackNowPct);

    onSignals.push({
      key: c.key,
      label: c.label,
      grade: c.grade,
      onSinceDate: bars[current.start].date,
      daysOn: lastIdx - current.start,
      fresh: lastIdx - current.start <= windowAfter,
      peakSinceOnDate: bars[peak.idx].date,
      givebackNowPct: nowGiveback,
      medianExitGivebackPct: medianExit,
      worstExitGivebackPct: exits.length ? Math.min(...exits) : null,
      exitSamples: exits.length,
      // 지금 가격에서 과거 중앙값 수준까지 더 빠지는 폭.
      furtherDropToExitPct:
        medianExit != null && nowGiveback != null
          ? ((1 + medianExit / 100) / (1 + nowGiveback / 100) - 1) * 100
          : null,
    });
  }

  onSignals.sort(
    (a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade] || b.daysOn - a.daysOn,
  );

  const graded = onSignals.filter((s) => s.grade === "A" || s.grade === "B");
  const pool = graded.length ? graded : onSignals;
  const freshCount = pool.filter((s) => s.fresh).length;
  const staleCount = pool.length - freshCount;
  const medianFurtherDropToExitPct = median(
    pool.map((s) => s.furtherDropToExitPct).filter((v): v is number => v != null),
  );

  // ── 단계 판정 ────────────────────────────────────────────────────
  let stage: PositionStage;
  if (last == null) stage = "판정불가";
  else if (!ongoing) stage = "하락 국면";
  else if (cyclePos.fromPeakPct != null && cyclePos.fromPeakPct <= -thresholds.bearPct / 2)
    stage = "고점권 되밀림";
  else if (cyclePos.progressPct == null) stage = "판정불가";
  else if (cyclePos.progressPct < 40) stage = "초기";
  else if (cyclePos.progressPct < 100) stage = "중반";
  else stage = "과거 중앙값 초과";

  // ── 경고 ─────────────────────────────────────────────────────────
  if (cyclePos.progressPct != null && medianPastGainPct != null) {
    notes.push(
      `지금 상승률은 과거 사이클 상승폭 중앙값(+${medianPastGainPct.toFixed(0)}%)의 ` +
        `${cyclePos.progressPct.toFixed(0)}%입니다(과거 ${pastGains.length}번 중 ` +
        `${cyclePos.exceededCount}번은 이미 넘어섰습니다). 사이클마다 상승폭은 몇 배씩 차이가 나므로 ` +
        `이 진행도는 '앞으로 얼마 남았다'는 예측이 아니라 '과거와 비교하면 이쯤'이라는 위치 표시입니다.`,
    );
  } else if (last != null) {
    notes.push(
      "끝난 과거 사이클이 없어 진행도를 잴 기준이 없습니다. 지금 상승률만 그대로 보세요.",
    );
  }

  if (staleCount) {
    const stale = pool.filter((s) => !s.fresh);
    const medianDaysOn = median(stale.map((s) => s.daysOn));
    notes.push(
      `지금 켜진 상위 등급 ${pool.length}개 중 ${staleCount}개는 켜진 지 ` +
        `${medianDaysOn == null ? "?" : medianDaysOn.toFixed(0)}거래일이 지났습니다(등급을 잰 창은 ` +
        `바닥 뒤 ${windowAfter}거래일까지). 등급표의 적중률·남은 상승·1년 수익률·낙폭은 전부 ` +
        `'그 지표가 켜지는 날' 기준으로 잰 값이라, 이미 오래전에 켜진 지표에는 적용되지 않습니다. ` +
        `'A등급이 켜져 있다'와 'A등급이 방금 켜졌다'는 전혀 다른 상태입니다.`,
    );
  }

  if (medianFurtherDropToExitPct != null) {
    notes.push(
      `지금 켜진 지표들은 과거에 '켜져 있던 동안의 최고가 대비 중앙값 ` +
        `${(median(pool.map((s) => s.medianExitGivebackPct).filter((v): v is number => v != null)) ?? 0).toFixed(0)}%'에서 꺼졌습니다. ` +
        `지표가 꺼지면 판다는 규칙을 쓰면 오늘 가격에서 추가로 중앙값 ` +
        `${medianFurtherDropToExitPct.toFixed(0)}%를 더 반납하고 나오게 됩니다. ` +
        `이 지표들은 상승 전환을 확인하는 용도로 채점된 것이지, 매도 시점으로 채점된 게 아닙니다.`,
    );
  }

  if (cyclePos.furtherDropToBearPct != null) {
    notes.push(
      `사이클 정의상 국면이 '하락'으로 뒤집히는 선은 이번 사이클 최고 종가 대비 ` +
        `−${thresholds.bearPct}%입니다. 오늘 종가에서 ${cyclePos.furtherDropToBearPct.toFixed(0)}% 더 빠지면 거기에 닿습니다.`,
    );
  }

  return {
    stage,
    cycle: cyclePos,
    onSignals,
    freshCount,
    staleCount,
    medianFurtherDropToExitPct,
    notes,
  };
}
