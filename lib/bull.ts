import type { EnrichedBar } from "@/types";
import { smaValue } from "@/lib/indicators";
import { TIMEFRAME_UNIT, type PeriodBar, type Timeframe } from "@/lib/timeframe";

/**
 * 상승장 지표 — "지금이 오르는 국면인가"를 봉 단위로 판정한다.
 *
 * 핵심은 봉마다 기준이 달라야 한다는 것이다. 일봉의 20/60/200선을 주봉에 그대로
 * 쓰면 200주 = 4년치라 아무 신호도 안 나오고, 월봉에 쓰면 계산 자체가 안 된다.
 * 그래서 봉마다 이평 기간·모멘텀 구간·신고가 창을 따로 잡는다 (TF_CONFIG).
 *
 * 각 지표는 상승/중립/하락 셋 중 하나를 내고, 점수는 그 평균이다
 * (상승 1점, 중립 0.5점, 하락 0점 → 100점 만점).
 */

export type Verdict = "bullish" | "neutral" | "bearish";

export type BullIndicator = {
  key: string;
  label: string;
  /** 지금 값 (예: "62.4") */
  value: string;
  /** 무엇을 봤고 어떤 기준이었는지 한 줄 */
  detail: string;
  verdict: Verdict;
};

export type BullReport = {
  ticker: string;
  timeframe: Timeframe;
  /** 마지막 봉이 반영하는 최신 거래일 */
  asOf: string;
  /** 마지막 봉의 시작일 */
  periodStart: string;
  /** 마지막 봉이 아직 진행 중인지 (그 구간의 일봉이 덜 찼는지) */
  inProgress: boolean;
  close: number;
  barCount: number;
  score: number;
  verdict: string;
  bullish: number;
  bearish: number;
  neutral: number;
  indicators: BullIndicator[];
  notes: string[];
};

export type TfConfig = {
  /** 이평 3종 (단기 / 중기 / 장기) */
  maShort: number;
  maMid: number;
  maLong: number;
  /** 장기 이평 기울기를 재는 구간 */
  slopeSpan: number;
  /** 크로스를 "최근"으로 쳐주는 구간 */
  crossWindow: number;
  /** 모멘텀 수익률 구간 */
  momentumSpan: number;
  /** 신고가 비교 창 (일봉 252 ≈ 1년, 주봉 52 = 1년, 월봉 12 = 1년) */
  highWindow: number;
  /** 이 개수는 있어야 지표가 다 채워진다 */
  minBars: number;
};

export const TF_CONFIG: Record<Timeframe, TfConfig> = {
  // 일봉: 흔히 쓰는 20/60/200일선.
  "1d": {
    maShort: 20,
    maMid: 60,
    maLong: 200,
    slopeSpan: 20,
    crossWindow: 20,
    momentumSpan: 60,
    highWindow: 252,
    minBars: 220,
  },
  // 주봉: 10/30/50주 ≈ 50/150/250일. 주봉에서 장기 추세를 보는 표준 조합.
  "1w": {
    maShort: 10,
    maMid: 30,
    maLong: 50,
    slopeSpan: 8,
    crossWindow: 8,
    momentumSpan: 13,
    highWindow: 52,
    minBars: 55,
  },
  // 월봉: 6/12/24개월. 5년치 일봉이면 60봉 남짓이라 이보다 길게는 못 잡는다.
  "1M": {
    maShort: 6,
    maMid: 12,
    maLong: 24,
    slopeSpan: 3,
    crossWindow: 3,
    momentumSpan: 6,
    highWindow: 12,
    minBars: 27,
  },
};

// ── 지표 계산기 ────────────────────────────────────────────────

/** 지수이동평균. 앞 n-1개는 null, n번째는 단순평균으로 시작한다. */
export function emaLine(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (n < 1 || values.length < n) return out;
  const k = 2 / (n + 1);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  let prev = sum / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI (Wilder). 0~100. */
export function rsiLine(values: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= n) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (n - 1) + (d > 0 ? d : 0)) / n;
    avgLoss = (avgLoss * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export type MacdPoint = { macd: number; signal: number; hist: number } | null;

/** MACD(12, 26, 9). signal은 macd선 자체에 다시 EMA를 건다. */
export function macdLine(values: number[], fast = 12, slow = 26, signal = 9): MacdPoint[] {
  const out: MacdPoint[] = new Array(values.length).fill(null);
  const fastLine = emaLine(values, fast);
  const slowLine = emaLine(values, slow);

  const diff: number[] = [];
  const diffIndex: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const f = fastLine[i];
    const s = slowLine[i];
    if (f == null || s == null) continue;
    diff.push(f - s);
    diffIndex.push(i);
  }
  if (diff.length < signal) return out;

  const signalLine = emaLine(diff, signal);
  for (let k = 0; k < diff.length; k++) {
    const sig = signalLine[k];
    if (sig == null) continue;
    out[diffIndex[k]] = { macd: diff[k], signal: sig, hist: diff[k] - sig };
  }
  return out;
}

// ── 판정 ───────────────────────────────────────────────────────

function band(value: number, bullAt: number, bearAt: number): Verdict {
  if (value >= bullAt) return "bullish";
  if (value <= bearAt) return "bearish";
  return "neutral";
}

function pct(n: number, digits = 1): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** 마지막 crossWindow 구간에서 단기선이 중기선을 뚫었는지. 뚫은 지 몇 봉인지도 준다. */
function recentCross(
  closes: number[],
  short: number,
  long: number,
  window: number,
): { direction: "golden" | "death"; barsAgo: number } | null {
  const last = closes.length - 1;
  for (let i = last; i > last - window && i >= 1; i--) {
    const sPrev = smaValue(closes, i - 1, short);
    const lPrev = smaValue(closes, i - 1, long);
    const sNow = smaValue(closes, i, short);
    const lNow = smaValue(closes, i, long);
    if (sPrev == null || lPrev == null || sNow == null || lNow == null) break;
    if (sPrev <= lPrev && sNow > lNow) return { direction: "golden", barsAgo: last - i };
    if (sPrev >= lPrev && sNow < lNow) return { direction: "death", barsAgo: last - i };
  }
  return null;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  bullish: "상승",
  neutral: "중립",
  bearish: "하락",
};

function overallVerdict(score: number): string {
  if (score >= 75) return "강한 상승장";
  if (score >= 60) return "상승 우위";
  if (score >= 40) return "중립 · 방향 없음";
  if (score >= 25) return "하락 우위";
  return "강한 하락장";
}

/**
 * 집계된 봉(일/주/월)에서 상승장 지표를 뽑는다.
 * bars는 aggregateBars()로 묶은 뒤 enrich()를 통과한 것이어야 한다.
 */
export function bullReport(
  ticker: string,
  timeframe: Timeframe,
  bars: EnrichedBar[],
  periods: PeriodBar[],
): BullReport {
  const cfg = TF_CONFIG[timeframe];
  const unit = TIMEFRAME_UNIT[timeframe];
  const n = bars.length;
  const last = n - 1;
  const closes = bars.map((b) => b.close);
  const cur = bars[last];
  const curPeriod = periods[last];

  const indicators: BullIndicator[] = [];
  const notes: string[] = [];

  const add = (ind: BullIndicator | null) => {
    if (ind) indicators.push(ind);
  };

  const maShort = smaValue(closes, last, cfg.maShort);
  const maMid = smaValue(closes, last, cfg.maMid);
  const maLong = smaValue(closes, last, cfg.maLong);

  // 1) 장기 추세 — 종가가 장기 이평 위인가
  if (maLong != null) {
    const gap = ((cur.close - maLong) / maLong) * 100;
    add({
      key: "trend",
      label: `장기 추세 (${cfg.maLong}${unit}선)`,
      value: pct(gap),
      detail: `종가가 ${cfg.maLong}${unit} 이평선보다 ${gap >= 0 ? "위" : "아래"}에 있습니다. +2% 위면 상승, -2% 아래면 하락.`,
      verdict: band(gap, 2, -2),
    });
  }

  // 2) 정배열 — 단기 > 중기 > 장기
  if (maShort != null && maMid != null && maLong != null) {
    const up = maShort > maMid && maMid > maLong;
    const down = maShort < maMid && maMid < maLong;
    add({
      key: "stack",
      label: "이평 배열",
      value: up ? "정배열" : down ? "역배열" : "혼조",
      detail: `${cfg.maShort} / ${cfg.maMid} / ${cfg.maLong}${unit}선의 순서입니다. 위에서부터 단→중→장이면 정배열.`,
      verdict: up ? "bullish" : down ? "bearish" : "neutral",
    });
  }

  // 3) 장기 이평 기울기 — 추세가 살아 있는가
  const maLongPast = smaValue(closes, last - cfg.slopeSpan, cfg.maLong);
  if (maLong != null && maLongPast != null && maLongPast > 0) {
    const slope = ((maLong - maLongPast) / maLongPast) * 100;
    add({
      key: "slope",
      label: `${cfg.maLong}${unit}선 기울기`,
      value: pct(slope, 2),
      detail: `최근 ${cfg.slopeSpan}봉 동안 ${cfg.maLong}${unit}선이 움직인 폭입니다. 우상향이면 추세가 살아 있습니다.`,
      verdict: band(slope, 0.5, -0.5),
    });
  }

  // 4) 골든/데드크로스 — 최근에 방향이 바뀌었는가
  const cross = recentCross(closes, cfg.maShort, cfg.maMid, cfg.crossWindow);
  if (maShort != null && maMid != null) {
    add({
      key: "cross",
      label: `${cfg.maShort}/${cfg.maMid} 크로스`,
      value: cross
        ? `${cross.direction === "golden" ? "골든" : "데드"} · ${cross.barsAgo}봉 전`
        : maShort > maMid
          ? "단기선 위"
          : "단기선 아래",
      detail: `최근 ${cfg.crossWindow}봉 안의 크로스만 봅니다. 없으면 지금 단기선이 중기선 위인지로 판단합니다.`,
      verdict: cross
        ? cross.direction === "golden"
          ? "bullish"
          : "bearish"
        : maShort > maMid
          ? "neutral"
          : "bearish",
    });
  }

  // 5) 모멘텀 — N봉 수익률
  const past = bars[last - cfg.momentumSpan];
  if (past && past.close > 0) {
    const ret = ((cur.close - past.close) / past.close) * 100;
    add({
      key: "momentum",
      label: `${cfg.momentumSpan}봉 수익률`,
      value: pct(ret),
      detail: `${cfg.momentumSpan}${unit} 전 종가 대비입니다. +5% 위면 상승, -5% 아래면 하락.`,
      verdict: band(ret, 5, -5),
    });
  }

  // 6) 신고가 근접도 — 고점에서 얼마나 떨어져 있나
  if (last >= 1) {
    const from = Math.max(0, last - cfg.highWindow + 1);
    let high = 0;
    for (let i = from; i <= last; i++) high = Math.max(high, bars[i].high);
    if (high > 0) {
      const ratio = (cur.close / high) * 100;
      const span = last - from + 1;
      add({
        key: "high",
        label: "고점 대비",
        value: `${ratio.toFixed(1)}%`,
        detail: `최근 ${span}봉 최고가 대비 현재 종가입니다. 95% 위면 신고가권, 80% 아래면 깊은 조정.`,
        verdict: band(ratio, 95, 80),
      });
    }
  }

  // 7) RSI — 과열/침체가 아니라 방향의 강도로 쓴다
  const rsi = rsiLine(closes, 14)[last];
  if (rsi != null) {
    add({
      key: "rsi",
      label: "RSI(14)",
      value: rsi.toFixed(1),
      detail: "55 위면 매수 우위, 45 아래면 매도 우위로 봅니다.",
      verdict: band(rsi, 55, 45),
    });
  }

  // 8) MACD — 추세 전환
  const macd = macdLine(closes)[last];
  if (macd != null && cur.close > 0) {
    // 히스토그램은 가격 단위라 종가의 0.1%를 중립 폭으로 둔다 (종목·봉마다 스케일이 다르다).
    const dead = cur.close * 0.001;
    add({
      key: "macd",
      label: "MACD(12,26,9)",
      value: `${macd.hist >= 0 ? "+" : ""}${macd.hist.toFixed(2)}`,
      detail: "MACD선이 시그널선 위면 상승 전환입니다. 히스토그램 부호로 판단합니다.",
      verdict: macd.hist > dead ? "bullish" : macd.hist < -dead ? "bearish" : "neutral",
    });
  }

  // 9) 매수/매도 거래량 비 — 오른 봉의 거래량이 더 많은가
  if (cur.up_down_vol_ratio_20d != null) {
    const r = cur.up_down_vol_ratio_20d;
    add({
      key: "flow",
      label: "매수/매도 거래량",
      value: r.toFixed(2),
      detail: "최근 20봉에서 오른 봉의 거래량 ÷ 내린 봉의 거래량. 1.15 위면 매수 우위.",
      verdict: band(r, 1.15, 0.85),
    });
  }

  // 10) OBV 기울기 — 자금이 들어오는가
  if (cur.obv_slope_20d != null) {
    const s = cur.obv_slope_20d;
    add({
      key: "obv",
      label: "OBV 기울기",
      value: s.toFixed(2),
      detail: "최근 20봉 OBV 추세를 평균 거래량으로 나눈 값입니다. 양수면 매집.",
      verdict: band(s, 0.15, -0.15),
    });
  }

  // 11) 펀딩비 — 코인만. 롱 우위지만 과열이면 오히려 경고다.
  if (cur.funding_pct != null) {
    const f = cur.funding_pct;
    const z = cur.funding_zscore_60d;
    const overheated = z != null && z >= 2;
    add({
      key: "funding",
      label: "펀딩비",
      value: `${f >= 0 ? "+" : ""}${f.toFixed(4)}%`,
      detail: overheated
        ? "롱이 몰려 과열입니다 (60봉 기준 +2σ). 상승장이어도 되돌림 위험이 큽니다."
        : "양수면 롱이 숏에 수수료를 냅니다 = 롱 우위.",
      verdict: overheated ? "bearish" : f > 0 ? "bullish" : f < 0 ? "bearish" : "neutral",
    });
  }

  // ── 점수 ──
  const weightOf: Record<Verdict, number> = { bullish: 1, neutral: 0.5, bearish: 0 };
  const total = indicators.reduce((a, i) => a + weightOf[i.verdict], 0);
  const score = indicators.length ? Math.round((total / indicators.length) * 100) : 0;

  const tfName = timeframe === "1M" ? "월봉" : timeframe === "1w" ? "주봉" : "일봉";
  if (n < cfg.minBars) {
    notes.push(
      `${tfName}이 ${n}개뿐이라 긴 이평(${cfg.maLong}${unit})을 쓰는 지표는 빠졌습니다. ` +
        "시세는 5년치까지만 받아옵니다.",
    );
  }
  const inProgress = isInProgress(curPeriod, timeframe);
  if (inProgress && curPeriod) {
    notes.push(
      `마지막 ${tfName}은 아직 진행 중입니다 (${curPeriod.date} ~ ${curPeriod.periodEnd}, ` +
        `일봉 ${curPeriod.dayCount}개). 구간이 끝날 때까지 값이 계속 바뀝니다.`,
    );
  }

  return {
    ticker,
    timeframe,
    asOf: curPeriod?.periodEnd ?? cur.date,
    periodStart: cur.date,
    inProgress,
    close: cur.close,
    barCount: n,
    score,
    verdict: overallVerdict(score),
    bullish: indicators.filter((i) => i.verdict === "bullish").length,
    neutral: indicators.filter((i) => i.verdict === "neutral").length,
    bearish: indicators.filter((i) => i.verdict === "bearish").length,
    indicators,
    notes,
  };
}

/** 마지막 봉이 아직 안 끝났는지. 주봉은 금요일, 월봉은 그 달 말일이 차야 끝난 것이다. */
function isInProgress(bar: PeriodBar | undefined, tf: Timeframe): boolean {
  if (!bar) return false;
  const end = new Date(`${bar.periodEnd}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return false;
  if (tf === "1w") return end.getUTCDay() !== 5; // 금요일이 아니면 진행 중
  if (tf === "1M") {
    const next = new Date(end);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.getUTCMonth() === end.getUTCMonth(); // 아직 같은 달이면 진행 중
  }
  return false;
}
