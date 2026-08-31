/**
 * 상승장 지표 배터리.
 *
 * 설계 원칙 두 가지:
 *
 * 1) 지표는 '상태(state)'로 정의한다.
 *    "종가가 200일선 위에 있다"처럼 켜짐/꺼짐이 있는 조건으로 쓰면
 *    ① 지금 켜져 있는지 ② 언제 켜졌는지(=신호 발생일, 상태의 상승 엣지)
 *    둘 다 공짜로 나온다. 신호를 따로 정의하지 않아도 된다.
 *
 * 2) 파라미터는 전부 관례적인 라운드 넘버로 고정한다.
 *    사이클 표본이 서너 개뿐인데 최적 기간을 탐색하면 노이즈를 맞추게 된다.
 *    "365일선이 아니라 347일선이 제일 좋았다" 같은 결과는 발견이 아니라 과최적화다.
 */

import type { Bar, EnrichedBar } from "@/types";
import {
  adx,
  bollinger,
  cci,
  ichimoku,
  macd,
  quantile,
  rollingMax,
  rollingMin,
  rsi,
  sma,
  stochastic,
} from "./ta";
import { projectToDaily, toMonthly, toWeekly } from "./resample";

export const SIGNAL_GROUPS = ["추세", "모멘텀", "변동성", "수급", "가격구조"] as const;
export type SignalGroup = (typeof SIGNAL_GROUPS)[number];

export type SignalDef = {
  key: string;
  label: string;
  group: SignalGroup;
  /** 왜 보는 지표인지 한 줄 설명. */
  why: string;
  timeframe: "일봉" | "주봉" | "월봉";
};

export type SignalSeries = SignalDef & {
  /** 각 일봉에서 조건이 켜져 있는지. 값이 확정되지 않은 앞구간은 null. */
  state: (boolean | null)[];
};

function gt(a: (number | null)[], b: (number | null)[]): (boolean | null)[] {
  return a.map((v, i) => (v == null || b[i] == null ? null : v > b[i]!));
}

function gtValue(a: (number | null)[], v: number): (boolean | null)[] {
  return a.map((x) => (x == null ? null : x > v));
}

function closesAbove(bars: Bar[], line: (number | null)[]): (boolean | null)[] {
  return line.map((v, i) => (v == null ? null : bars[i].close > v));
}

/** 주봉/월봉 지표를 일봉 타임라인으로. 진행 중인 기간은 쓰지 않는다 (resample.ts 주석 참고). */
function fromPeriod(
  periodOf: number[],
  periodState: (boolean | null)[],
): (boolean | null)[] {
  return projectToDaily(periodOf, periodState, null);
}

export function buildSignals(bars: EnrichedBar[]): SignalSeries[] {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const n = bars.length;
  const out: SignalSeries[] = [];

  const push = (def: SignalDef, state: (boolean | null)[]) => {
    // 전 구간이 null이면(데이터 부족) 아예 목록에 넣지 않는다.
    if (state.some((v) => v != null)) out.push({ ...def, state });
  };

  // ── 추세 ────────────────────────────────────────────────────────
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma60 = sma(closes, 60);
  const ma120 = sma(closes, 120);
  const ma200 = sma(closes, 200);
  const ma365 = sma(closes, 365);

  push(
    { key: "ma50", label: "50일선 위", group: "추세", why: "중기 추세 전환의 첫 확인", timeframe: "일봉" },
    closesAbove(bars, ma50),
  );
  push(
    { key: "ma120", label: "120일선 위", group: "추세", why: "국내에서 '경기선'이라 부르는 중기 기준선", timeframe: "일봉" },
    closesAbove(bars, ma120),
  );
  push(
    { key: "ma200", label: "200일선 위", group: "추세", why: "장기 강세/약세를 가르는 가장 널리 쓰이는 기준선", timeframe: "일봉" },
    closesAbove(bars, ma200),
  );
  push(
    { key: "ma365", label: "365일선(1년선) 위", group: "추세", why: "1년 평균 매수단가. 코인 사이클 전환 판정에 자주 쓴다", timeframe: "일봉" },
    closesAbove(bars, ma365),
  );
  push(
    { key: "gc_20_60", label: "20/60일선 골든크로스", group: "추세", why: "단기선이 중기선을 넘는 초기 전환 신호", timeframe: "일봉" },
    gt(ma20, ma60),
  );
  push(
    { key: "gc_50_200", label: "50/200일선 골든크로스", group: "추세", why: "가장 유명한 정통 골든크로스", timeframe: "일봉" },
    gt(ma50, ma200),
  );

  // 200일선 자체가 우상향으로 꺾였는가. 가격이 선 위로 올라온 것보다 늦지만 더 확실하다.
  const ma200Slope: (boolean | null)[] = new Array(n).fill(null);
  for (let i = 20; i < n; i++) {
    if (ma200[i] != null && ma200[i - 20] != null) ma200Slope[i] = ma200[i]! > ma200[i - 20]!;
  }
  push(
    { key: "ma200_slope", label: "200일선 기울기 상승", group: "추세", why: "선 자체가 우상향으로 꺾였는지. 늦지만 잘 안 속는다", timeframe: "일봉" },
    ma200Slope,
  );

  const cloud = ichimoku(bars);
  push(
    { key: "ichimoku", label: "일목 구름 위", group: "추세", why: "구름 상단 돌파는 추세 전환의 대표 신호", timeframe: "일봉" },
    closesAbove(bars, cloud.cloudTop),
  );

  // ── 주봉 / 월봉 ──────────────────────────────────────────────────
  const weekly = toWeekly(bars);
  const wCloses = weekly.bars.map((b) => b.close);
  const wMa30 = sma(wCloses, 30);
  const wMa200 = sma(wCloses, 200);
  push(
    { key: "w_ma30", label: "30주선 위 (주봉)", group: "추세", why: "주봉 30주선은 중장기 강세장의 고전적 기준", timeframe: "주봉" },
    fromPeriod(weekly.periodOf, wCloses.map((c, i) => (wMa30[i] == null ? null : c > wMa30[i]!))),
  );
  const wMa50 = sma(wCloses, 50);
  push(
    { key: "w_ma50", label: "50주선 위 (주봉)", group: "추세", why: "약 1년치 주봉 평균. 30주선과 200주선 사이를 메우는 중장기 기준선", timeframe: "주봉" },
    fromPeriod(weekly.periodOf, wCloses.map((c, i) => (wMa50[i] == null ? null : c > wMa50[i]!))),
  );
  push(
    { key: "w_ma200", label: "200주선 위 (주봉)", group: "추세", why: "코인 사이클 바닥권 판정에 가장 많이 인용되는 선", timeframe: "주봉" },
    fromPeriod(weekly.periodOf, wCloses.map((c, i) => (wMa200[i] == null ? null : c > wMa200[i]!))),
  );

  const wMacd = macd(wCloses);
  push(
    { key: "macd_w", label: "주봉 MACD 골든크로스", group: "모멘텀", why: "중기 모멘텀 전환. 하락장 종료 확인에 널리 쓴다", timeframe: "주봉" },
    fromPeriod(weekly.periodOf, gt(wMacd.macd, wMacd.signal)),
  );
  const wRsi = rsi(wCloses);
  push(
    { key: "rsi_w50", label: "주봉 RSI 50 위", group: "모멘텀", why: "주간 모멘텀이 매수 우위로 넘어갔는지", timeframe: "주봉" },
    fromPeriod(weekly.periodOf, gtValue(wRsi, 50)),
  );

  const monthly = toMonthly(bars);
  const mCloses = monthly.bars.map((b) => b.close);
  const mMacd = macd(mCloses);
  push(
    { key: "macd_m", label: "월봉 MACD 골든크로스", group: "모멘텀", why: "사이클 단위 전환 신호. 가장 느리지만 가장 덜 속는다", timeframe: "월봉" },
    fromPeriod(monthly.periodOf, gt(mMacd.macd, mMacd.signal)),
  );
  const mRsi = rsi(mCloses);
  push(
    { key: "rsi_m50", label: "월봉 RSI 50 위", group: "모멘텀", why: "월간 모멘텀이 매수 우위로 넘어가는 자리. 코인 사이클 전환에 자주 인용된다", timeframe: "월봉" },
    fromPeriod(monthly.periodOf, gtValue(mRsi, 50)),
  );
  const mMa12 = sma(mCloses, 12);
  push(
    { key: "m_ma12", label: "12개월선 위 (월봉)", group: "추세", why: "장기 투자자가 보는 1년 이동평균", timeframe: "월봉" },
    fromPeriod(monthly.periodOf, mCloses.map((c, i) => (mMa12[i] == null ? null : c > mMa12[i]!))),
  );

  // ── 모멘텀 (일봉) ────────────────────────────────────────────────
  const dMacd = macd(closes);
  push(
    { key: "macd_d", label: "일봉 MACD 골든크로스", group: "모멘텀", why: "단기 모멘텀 전환", timeframe: "일봉" },
    gt(dMacd.macd, dMacd.signal),
  );
  push(
    { key: "macd_d_zero", label: "일봉 MACD 0선 위", group: "모멘텀", why: "골든크로스보다 한 단계 강한 확인", timeframe: "일봉" },
    gtValue(dMacd.macd, 0),
  );

  const dRsi = rsi(closes);
  push(
    { key: "rsi_d50", label: "RSI 50 위", group: "모멘텀", why: "매수·매도 균형이 매수 쪽으로 기울었는지", timeframe: "일봉" },
    gtValue(dRsi, 50),
  );

  // 과매도(30 이하)를 찍고 45를 회복한 상태. 바닥권 반등의 전형적 형태.
  const rsiRecover: (boolean | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const cur = dRsi[i];
    if (cur == null) continue;
    let wasOversold = false;
    for (let k = Math.max(0, i - 60); k <= i; k++) {
      const v = dRsi[k];
      if (v != null && v <= 30) {
        wasOversold = true;
        break;
      }
    }
    rsiRecover[i] = wasOversold && cur > 45;
  }
  push(
    { key: "rsi_recover", label: "RSI 과매도 탈출", group: "모멘텀", why: "30 이하를 찍고 45를 회복 — 바닥권 반등의 전형", timeframe: "일봉" },
    rsiRecover,
  );

  const st = stochastic(bars);
  push(
    { key: "stoch", label: "스토캐스틱 골든크로스", group: "모멘텀", why: "%K가 %D를 상향 돌파", timeframe: "일봉" },
    gt(st.k, st.d),
  );

  push(
    { key: "cci", label: "CCI -100 위", group: "모멘텀", why: "과매도 구간 이탈", timeframe: "일봉" },
    gtValue(cci(bars), -100),
  );

  // ── 변동성 / 밴드 ────────────────────────────────────────────────
  const bb = bollinger(closes);
  push(
    { key: "bb_mid", label: "볼린저 중심선 위", group: "변동성", why: "20일 평균 회복 = 단기 균형 회복", timeframe: "일봉" },
    closesAbove(bars, bb.mid),
  );

  // 밴드가 최근 120일 중 하위 20%로 좁아진 뒤 상단을 뚫는 형태.
  const squeeze: (boolean | null)[] = new Array(n).fill(null);
  for (let i = 120; i < n; i++) {
    const upper = bb.upper[i];
    const bwNow = bb.bandwidth[i - 1];
    if (upper == null || bwNow == null) continue;
    const window: number[] = [];
    for (let k = i - 120; k < i; k++) {
      const v = bb.bandwidth[k];
      if (v != null) window.push(v);
    }
    const q = quantile(window, 0.2);
    squeeze[i] = q != null && bwNow <= q && bars[i].close > upper;
  }
  push(
    { key: "bb_squeeze", label: "볼린저 스퀴즈 돌파", group: "변동성", why: "변동성이 죽은 뒤 위로 터지는 자리", timeframe: "일봉" },
    squeeze,
  );

  const dmi = adx(bars);
  const adxTrend: (boolean | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = dmi.adx[i];
    const p = dmi.plusDI[i];
    const m = dmi.minusDI[i];
    if (a == null || p == null || m == null) continue;
    adxTrend[i] = a > 20 && p > m;
  }
  push(
    { key: "adx", label: "ADX 상승추세 진입", group: "변동성", why: "ADX 20 위 + 상승 방향(+DI>-DI) — 추세가 실제로 붙었는지", timeframe: "일봉" },
    adxTrend,
  );

  // ── 수급 ────────────────────────────────────────────────────────
  push(
    { key: "obv", label: "OBV 상승 전환", group: "수급", why: "누적 거래량 기울기가 양(+)으로 — 매집 흔적", timeframe: "일봉" },
    bars.map((b) => (b.obv_slope_20d == null ? null : b.obv_slope_20d > 0)),
  );
  push(
    { key: "updown_vol", label: "상승 거래량 우위", group: "수급", why: "20일 상승일 거래량이 하락일보다 20% 이상 많음", timeframe: "일봉" },
    bars.map((b) => (b.up_down_vol_ratio_20d == null ? null : b.up_down_vol_ratio_20d > 1.2)),
  );
  push(
    { key: "vol_surge", label: "거래량 급증 상승", group: "수급", why: "20일 평균 2배 거래량 + 상승 마감", timeframe: "일봉" },
    bars.map((b, i) =>
      b.volume_ratio_20d == null || i === 0
        ? null
        : b.volume_ratio_20d >= 2 && b.close > bars[i - 1].close,
    ),
  );

  // ── 가격 구조 ────────────────────────────────────────────────────
  const high52 = rollingMax(highs, 252);
  const low52 = rollingMin(lows, 252);
  push(
    { key: "high_52w", label: "52주 신고가", group: "가격구조", why: "신고가는 그 자체로 강세장의 정의에 가깝다", timeframe: "일봉" },
    bars.map((b, i) => (high52[i] == null ? null : b.close >= high52[i]! * 0.999)),
  );
  push(
    { key: "off_low_20", label: "52주 저점 +20%", group: "가격구조", why: "저점 대비 20% 상승 — 강세장의 교과서적 정의", timeframe: "일봉" },
    bars.map((b, i) => (low52[i] == null ? null : b.close >= low52[i]! * 1.2)),
  );

  // 최근 60일의 고점·저점이 그 이전 60일보다 모두 높은가 (고점·저점 동시 상승).
  const hh = rollingMax(highs, 60);
  const ll = rollingMin(lows, 60);
  const hhhl: (boolean | null)[] = new Array(n).fill(null);
  for (let i = 120; i < n; i++) {
    if (hh[i] == null || hh[i - 60] == null || ll[i] == null || ll[i - 60] == null) continue;
    hhhl[i] = hh[i]! > hh[i - 60]! && ll[i]! > ll[i - 60]!;
  }
  push(
    { key: "hh_hl", label: "고점·저점 동시 상승", group: "가격구조", why: "다우 이론의 상승 추세 정의", timeframe: "일봉" },
    hhhl,
  );

  return out;
}
