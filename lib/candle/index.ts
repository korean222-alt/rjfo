/**
 * 캔들 패턴 분석의 진입점.
 *
 * 티커 하나를 받아서
 *   1) 모든 봉을 하나씩 읽어 어떤 캔들 패턴이 완성됐는지 표시하고
 *   2) 패턴마다 "그 다음 N거래일에 실제로 무슨 일이 있었나"를 전부 채점하고
 *   3) 아무 날이나 산 것(기저율)과 비교해 등급을 매기고
 *   4) 지금 마지막 봉에 무엇이 떴는지, 과거 같은 모양 뒤에 무슨 일이 있었는지 알려준다.
 *
 * 숫자는 전부 이 파일 아래의 TypeScript가 계산한다. LLM은 결과를 문장으로 옮길 뿐이다.
 *
 * 이 화면이 '예측'을 자처하지 않는 이유는 warnings에 그대로 적어 내보낸다.
 * 캔들 패턴의 실제 효과는 대개 기저율 대비 몇 %p 수준이고, 그마저도 종목·기간을
 * 바꾸면 사라지는 경우가 많다. 그걸 숨기면 이 화면은 점집이 된다.
 */

import type { EnrichedBar } from "@/types";
import {
  CANDLE_HORIZONS,
  DEFAULT_HORIZON,
  HORIZON_LABEL,
  baselineStats,
  evaluatePattern,
  forwardSeries,
  type CandleBaseline,
  type CandleHorizon,
} from "./evaluate";
import { gradePatterns, type Grade, type GradedPattern } from "./grade";
import {
  anatomyOf,
  avgRangeSeries,
  buildPatterns,
  describeShape,
  type Anatomy,
  type PatternBias,
} from "./patterns";

export * from "./evaluate";
export * from "./grade";
export * from "./patterns";

/** 최근 몇 봉을 '하나하나 읽기'로 보여줄지. */
export const READ_BARS = 40;

/**
 * 마지막 봉에서 며칠 전까지의 패턴을 '아직 살아 있다'고 볼지.
 *
 * 채점 구간이 5거래일인데 어제 뜬 신호를 없는 셈 치면, 하루만 늦게 열어봐도
 * 화면이 텅 빈다. 오늘·어제까지만 살아 있는 것으로 본다.
 */
export const ACTIVE_WITHIN = 2;

export type PatternHit = {
  key: string;
  label: string;
  bias: PatternBias;
  grade: Grade;
  passCount: number;
  /** 며칠 전 봉에서 완성됐는지. 0이면 오늘. */
  daysAgo: number;
};

/** 봉 하나를 읽은 결과. 화면의 '캔들 하나하나 읽기' 표가 이걸 그대로 쓴다. */
export type ReadBar = Anatomy & {
  open: number;
  high: number;
  low: number;
  close: number;
  /** 모양 한 마디 ("아랫꼬리 긴 양봉"). */
  shape: string;
  /** 이 봉에서 완성된 패턴들. */
  patterns: PatternHit[];
  /** 이 봉 뒤 채점 구간의 실제 수익률(%). 최근 봉은 미래가 없어 null. */
  forwardPct: number | null;
};

export type Outlook = {
  date: string;
  /** 지금 살아 있는(오늘·어제 완성된) 패턴들. */
  active: PatternHit[];
  /** 그중 등급이 A·B라 근거로 쓸 만한 것. */
  usable: PatternHit[];
  bias: "상승 우세" | "하락 우세" | "엇갈림" | "근거 없음";
  /** 근거 있는 패턴들의 과거 평균 수익률(발생 횟수 가중, %). 방향을 곱하지 않은 날것. */
  expectedPct: number | null;
  /** 그 패턴들의 과거 방향 적중률(가중 평균, %). */
  successRate: number | null;
  /** 같은 기간 아무 날이나 샀을 때의 상승 비율(%). 비교 기준. */
  baseUpRate: number | null;
  /** 한 줄 근거. 화면과 LLM이 같은 문장을 본다. */
  basis: string;
};

export type CandleReport = {
  ticker: string;
  assetClass: "코인" | "주식";
  periodStart: string;
  periodEnd: string;
  totalBars: number;
  years: number;
  /** 채점 구간 (거래일). */
  horizon: CandleHorizon;
  horizons: number[];
  baseline: CandleBaseline;
  patterns: GradedPattern[];
  /** 최근 봉들을 하나씩 읽은 결과 (오래된 것 → 최신). */
  read: ReadBar[];
  outlook: Outlook;
  reliability: "매우 낮음" | "낮음" | "보통";
  warnings: string[];
};

export type AnalyzeCandleOptions = {
  horizon?: CandleHorizon;
  /** 최근 몇 봉을 읽어서 보여줄지. */
  readBars?: number;
};

export function analyzeCandles(
  ticker: string,
  bars: EnrichedBar[],
  opts: AnalyzeCandleOptions = {},
): CandleReport {
  const horizon = opts.horizon ?? DEFAULT_HORIZON;
  const readCount = Math.max(5, Math.min(200, opts.readBars ?? READ_BARS));
  const lastIdx = bars.length - 1;

  const series = buildPatterns(bars);
  const baseline = baselineStats(bars);
  const evaluated = series.map((p) => evaluatePattern(bars, p, baseline, { horizon }));
  const patterns = gradePatterns(evaluated).sort((a, b) => b.score - a.score);

  const byKey = new Map(patterns.map((p) => [p.key, p]));
  const hitAt = (i: number): PatternHit[] =>
    series
      .filter((s) => s.at[i])
      .map((s) => {
        const g = byKey.get(s.key);
        return {
          key: s.key,
          label: s.label,
          bias: s.bias,
          grade: g?.grade ?? "D",
          passCount: g?.passCount ?? 0,
          daysAgo: lastIdx - i,
        };
      })
      // 근거가 센 것부터. 같은 봉에 다섯 개가 떠도 무엇을 먼저 볼지 정해준다.
      .sort((a, b) => b.passCount - a.passCount);

  const avgRange = avgRangeSeries(bars);
  const fwd = forwardSeries(bars, horizon);
  const read: ReadBar[] = [];
  for (let i = Math.max(0, bars.length - readCount); i < bars.length; i++) {
    const anatomy = anatomyOf(bars, i, avgRange);
    read.push({
      ...anatomy,
      open: bars[i].open,
      high: bars[i].high,
      low: bars[i].low,
      close: bars[i].close,
      shape: describeShape(anatomy),
      patterns: hitAt(i),
      forwardPct: fwd[i],
    });
  }

  const outlook = buildOutlook(bars, patterns, series, baseline, horizon, lastIdx);

  const years = bars.length ? tradingYears(bars[0].date, bars[lastIdx].date) : 0;
  const graded = patterns.filter((p) => p.independentCount >= 20).length;
  const reliability = years >= 10 && graded >= 10 ? "보통" : years >= 5 ? "낮음" : "매우 낮음";

  return {
    ticker,
    assetClass: /-USD$/.test(ticker) ? "코인" : "주식",
    periodStart: bars[0]?.date ?? "",
    periodEnd: bars[lastIdx]?.date ?? "",
    totalBars: bars.length,
    years,
    horizon,
    horizons: [...CANDLE_HORIZONS],
    baseline,
    patterns,
    read,
    outlook,
    reliability,
    warnings: buildWarnings(ticker, bars, patterns, baseline, horizon, years),
  };
}

function buildOutlook(
  bars: EnrichedBar[],
  patterns: GradedPattern[],
  series: ReturnType<typeof buildPatterns>,
  baseline: CandleBaseline,
  horizon: CandleHorizon,
  lastIdx: number,
): Outlook {
  const byKey = new Map(patterns.map((p) => [p.key, p]));
  const active: PatternHit[] = [];
  for (let i = Math.max(0, lastIdx - (ACTIVE_WITHIN - 1)); i <= lastIdx; i++) {
    for (const s of series) {
      if (!s.at[i]) continue;
      const g = byKey.get(s.key);
      active.push({
        key: s.key,
        label: s.label,
        bias: s.bias,
        grade: g?.grade ?? "D",
        passCount: g?.passCount ?? 0,
        daysAgo: lastIdx - i,
      });
    }
  }
  active.sort((a, b) => b.passCount - a.passCount || a.daysAgo - b.daysAgo);

  const usable = active.filter((h) => h.grade === "A" || h.grade === "B");
  const baseStat = baseline.byHorizon[String(horizon)];
  const date = bars[lastIdx]?.date ?? "";

  if (!usable.length) {
    const why = active.length
      ? `지금 떠 있는 패턴 ${active.length}개는 전부 등급이 낮습니다(과거 성적이 아무 날이나 산 것과 구별되지 않음).`
      : "지금 봉에서는 채점 대상 패턴이 완성되지 않았습니다.";
    return {
      date,
      active,
      usable: [],
      bias: "근거 없음",
      expectedPct: null,
      successRate: null,
      baseUpRate: baseStat.upRate,
      basis: `${why} 이 종목의 기저율(아무 날이나 사서 ${HORIZON_LABEL[horizon]} 뒤) 상승 확률은 ${fmtPct(baseStat.upRate)}, 평균 ${fmtSigned(baseStat.avg, 2)}입니다.`,
    };
  }

  // 여러 패턴이 같이 떴을 때는 발생 횟수로 가중해 평균을 낸다.
  // (표본 세 번짜리 패턴이 표본 200번짜리와 같은 무게를 가지면 안 된다.)
  let wSum = 0;
  let retSum = 0;
  let rateSum = 0;
  let upVotes = 0;
  let downVotes = 0;
  for (const h of usable) {
    const p = byKey.get(h.key);
    if (!p || p.avgMovePct == null || p.successRate == null) continue;
    const w = p.independentCount;
    wSum += w;
    retSum += p.avgMovePct * w;
    rateSum += p.successRate * w;
    if (p.bias === "상승") upVotes += w;
    else downVotes += w;
  }

  const expectedPct = wSum > 0 ? retSum / wSum : null;
  const successRate = wSum > 0 ? rateSum / wSum : null;
  const bias: Outlook["bias"] =
    upVotes > 0 && downVotes > 0
      ? "엇갈림"
      : upVotes > 0
        ? "상승 우세"
        : downVotes > 0
          ? "하락 우세"
          : "근거 없음";

  const names = usable.slice(0, 3).map((h) => `${h.label}(${h.grade}·${h.passCount}/6)`).join(", ");
  const basis =
    `${names}${usable.length > 3 ? ` 외 ${usable.length - 3}개` : ""}가 떴습니다. ` +
    `과거 같은 모양 뒤 ${HORIZON_LABEL[horizon]}은 평균 ${fmtSigned(expectedPct, 2)}, ` +
    `방향 적중 ${fmtPct(successRate)}였습니다 — 같은 기간 아무 날이나 샀을 때는 상승 ${fmtPct(baseStat.upRate)}, ` +
    `평균 ${fmtSigned(baseStat.avg, 2)}입니다.`;

  return { date, active, usable, bias, expectedPct, successRate, baseUpRate: baseStat.upRate, basis };
}

function buildWarnings(
  ticker: string,
  bars: EnrichedBar[],
  patterns: GradedPattern[],
  baseline: CandleBaseline,
  horizon: CandleHorizon,
  years: number,
): string[] {
  const w: string[] = [];
  const base = baseline.byHorizon[String(horizon)];

  w.push(
    `기준선부터 봅니다: 이 종목은 아무 날이나 사도 ${HORIZON_LABEL[horizon]} 뒤에 오를 확률이 ${fmtPct(base.upRate)}, ` +
      `평균 ${fmtSigned(base.avg, 2)}입니다. 캔들 패턴의 적중률은 반드시 이 숫자와 비교해서 읽어야 합니다 — ` +
      `"적중률 60%"는 기저가 58%면 아무것도 아닙니다.`,
  );

  const tested = patterns.length;
  const rawSig = patterns.filter((p) => p.chance != null && p.chance < 0.05).length;
  const afterFdr = patterns.filter((p) => p.qValue != null && p.qValue < 0.1).length;
  w.push(
    `패턴 ${tested}가지를 한꺼번에 검사했습니다. 아무 의미 없는 것만 ${tested}가지 늘어놔도 평균 ` +
      `${(tested * 0.05).toFixed(1)}개는 '우연일 확률 5% 미만'이 됩니다(다중검정) — 지금 그게 ${rawSig}개입니다. ` +
      `그래서 보정한 확률(q값)을 따로 매겼고, 보정 후에도 남는 건 ${afterFdr}개입니다. 등급은 이 q값으로 판정합니다.`,
  );

  w.push(
    `표본은 겹치지 않는 발생만 셉니다. 적삼병처럼 사흘 연속 뜨는 패턴은 그 셋의 '다음 ${horizon}일'이 ` +
      `거의 같은 기간이라, 셋을 독립 시행으로 세면 표본이 부풀어 우연일 확률이 실제보다 낮게 나옵니다.`,
  );

  const aGrade = patterns.filter((p) => p.grade === "A");
  w.push(
    aGrade.length
      ? `여섯 관문을 다 통과한 패턴이 ${aGrade.length}개입니다(${aGrade.map((p) => p.label).join(", ")}). ` +
          `그래도 이건 이 종목·이 기간에서만 확인된 것이고, 다른 종목에 그대로 옮겨 쓸 근거는 아닙니다.`
      : "여섯 관문을 다 통과한 패턴은 없습니다. 이 종목·이 기간에서 '이 캔들이 뜨면 오른다'고 말할 근거는 데이터에 없습니다 — " +
          "이게 정상적인 결과입니다. 캔들 패턴 연구들이 대체로 같은 결론을 냅니다.",
  );

  w.push(
    "수익률은 패턴이 완성된 날 종가에 사서 채점 구간 뒤 종가에 판 것으로 계산했습니다. " +
      "수수료·세금·슬리피지·호가 공백은 넣지 않았습니다. 실제로는 이 숫자보다 낮습니다.",
  );

  w.push(
    "'하락 뒤'·'상승 뒤' 같은 추세 조건은 패턴 완성 직전(전날 종가)까지만 보고 판정합니다. " +
      "당일 종가로 추세를 재면 크게 오른 날이 저절로 '상승 뒤'가 되어 결과가 순환 논리가 됩니다.",
  );

  if (/-USD$/.test(ticker)) {
    w.push(
      "코인은 24시간 거래라 일봉의 시가·종가가 거래소와 시간대(UTC 기준) 설정에 따라 달라집니다. " +
        "캔들 모양 자체가 소스마다 조금씩 다르므로, 여기 결과는 이 데이터 소스의 일봉 기준입니다.",
    );
  } else {
    w.push(
      "주식은 갭이 흔합니다. 다음 날 시가가 종가와 크게 벌어지면 여기 계산(종가→종가)과 실제 체결가가 달라집니다.",
    );
  }

  w.push(
    `데이터는 ${bars.length}봉(약 ${years.toFixed(1)}년)입니다. 캔들 패턴은 시장 구조가 바뀌면 함께 바뀝니다 — ` +
      "옛날 기간에서만 통한 패턴을 걸러내려고 앞뒤 기간을 나눠 채점하는 관문을 뒀습니다.",
  );

  w.push(
    "A등급 개수는 종목끼리 비교하지 마세요. 발생 횟수·기저율·기간 길이에 크게 좌우됩니다.",
  );

  return w;
}

function tradingYears(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / (365.25 * 86400000);
}

function fmtPct(v: number | null | undefined, digits = 0): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;
}

function fmtSigned(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** LLM에 넘길 사실 요약. 여기 없는 숫자는 모델이 만들어낼 수 없다. */
export function factsForLlm(report: CandleReport, topN = 8): string {
  const brief = (p: GradedPattern) => ({
    패턴: p.label,
    방향: p.bias,
    등급: p.grade,
    통과관문: `${p.passCount}/6`,
    발생: p.count,
    "겹치지않는발생": p.independentCount,
    적중률: p.successRate == null ? null : Math.round(p.successRate),
    기저적중률: p.baseRate == null ? null : Math.round(p.baseRate),
    적중률차이: p.rateEdge == null ? null : Number(p.rateEdge.toFixed(1)),
    평균수익: p.avgMovePct == null ? null : Number(p.avgMovePct.toFixed(2)),
    기저대비: p.edge == null ? null : Number(p.edge.toFixed(2)),
    역행폭중앙값: p.adverse.medianPct == null ? null : Number(p.adverse.medianPct.toFixed(1)),
    우연일확률: p.chance == null ? null : Number(p.chance.toFixed(4)),
    보정후q: p.qValue == null ? null : Number(p.qValue.toFixed(4)),
    앞뒤기간모두통함: p.walkForward?.heldUp ?? null,
    마지막발생: p.lastDate,
  });

  const base = report.baseline.byHorizon[String(report.horizon)];
  return JSON.stringify({
    티커: report.ticker,
    기간: `${report.periodStart}~${report.periodEnd}`,
    봉수: report.totalBars,
    채점구간: `${report.horizon}거래일`,
    기저_상승확률: base.upRate == null ? null : Math.round(base.upRate),
    기저_평균수익: base.avg == null ? null : Number(base.avg.toFixed(2)),
    검사한패턴수: report.patterns.length,
    "A등급(여섯관문통과)": report.patterns.filter((p) => p.grade === "A").map(brief),
    "B등급": report.patterns.filter((p) => p.grade === "B").map(brief),
    상위패턴: report.patterns.slice(0, topN).map(brief),
    마지막봉: report.read.length
      ? {
          날짜: report.read[report.read.length - 1].date,
          모양: report.read[report.read.length - 1].shape,
          등락: report.read[report.read.length - 1].changePct == null
            ? null
            : Number(report.read[report.read.length - 1].changePct!.toFixed(2)),
          거래량배수:
            report.read[report.read.length - 1].volumeRatio == null
              ? null
              : Number(report.read[report.read.length - 1].volumeRatio!.toFixed(2)),
        }
      : null,
    지금뜬패턴: report.outlook.active.map((h) => `${h.label}(${h.grade}·${h.daysAgo}일전)`),
    근거있는패턴: report.outlook.usable.map((h) => h.label),
    전망: report.outlook.bias,
    전망근거: report.outlook.basis,
    "최근10봉": report.read.slice(-10).map((b) => ({
      날짜: b.date,
      모양: b.shape,
      등락: b.changePct == null ? null : Number(b.changePct.toFixed(2)),
      패턴: b.patterns.map((p) => p.label),
    })),
  });
}
