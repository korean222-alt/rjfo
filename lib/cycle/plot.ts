/**
 * 지표 하나를 차트에 어떻게 그릴지.
 *
 * 성적표에서 지표를 고르면 그 지표 '자체'가 차트에 나와야 한다.
 * 200일선을 고르면 200일선이, MACD를 고르면 아래 패널에 MACD와 시그널선이.
 * 30개를 한꺼번에 겹치면 아무것도 안 보이므로 항상 하나만 그린다.
 *
 * 계산은 서버 채점과 같은 함수(ta.ts, indicators.ts)를 브라우저에서 그대로 돌린다.
 * 다른 구현으로 다시 짜면 "차트에선 선 위인데 신호는 안 떴다" 같은 어긋남이 생긴다.
 */

import { COMBO_PREFIX } from "./combos";
import type { EnrichedBar } from "@/types";
import { enrich } from "@/lib/indicators";
import {
  adx,
  bollinger,
  cci,
  ichimoku,
  macd,
  rollingMax,
  rollingMin,
  rsi,
  sma,
  stochastic,
} from "./ta";
import {
  projectToDaily,
  toMonthly,
  toWeekly,
  type ChartTf,
  CHART_TF_LABEL,
  CHART_TF_UNIT,
} from "./resample";

export type PlotPoint = { date: string; value: number };

export type PlotLine = {
  label: string;
  color: string;
  data: PlotPoint[];
  dashed?: boolean;
  width?: number;
};

export type PlotLevel = { value: number; label: string };

export type PlotPane = { title: string; lines: PlotLine[]; levels: PlotLevel[] };

export type SignalPlot = {
  /** 캔들 차트 위에 겹칠 선. */
  overlays: PlotLine[];
  /** 가격과 단위가 달라 따로 그려야 하는 지표 (MACD, RSI 등). */
  pane: PlotPane | null;
  /**
   * 패널이 둘 이상일 때 (조합 신호: "주봉 MACD + 상승 거래량 우위"처럼
   * 단위가 다른 지표 두 개를 동시에 봐야 한다). 비어 있으면 pane 하나만 그린다.
   */
  panes?: PlotPane[];
  /** 무엇이 켜짐 조건인지 사람 말로. 차트 아래 캡션. */
  rule: string;
  /**
   * 그릴 수 없거나 성적표와 다르게 읽힐 때 화면에 띄울 경고. 없으면 null.
   * 빈 차트를 그냥 보여주면 사용자는 '지표가 고장났다'고 읽는다.
   */
  note?: string | null;
};

/**
 * 조합 신호의 그림 = 구성 지표 둘의 그림을 겹친 것.
 *
 * 오버레이는 그냥 합치고, 별도 패널은 둘 다 남긴다(MACD와 RSI를 한 축에 그리면
 * 둘 다 못 읽는다). 같은 선이 두 번 그려지지 않게 라벨로 한 번 거른다.
 */
export function mergePlots(a: SignalPlot, b: SignalPlot): SignalPlot {
  const seen = new Set<string>();
  const overlays = [...a.overlays, ...b.overlays].filter((l) => {
    if (seen.has(l.label)) return false;
    seen.add(l.label);
    return true;
  });
  const panes = [...(a.panes ?? (a.pane ? [a.pane] : [])), ...(b.panes ?? (b.pane ? [b.pane] : []))];
  const uniquePanes = panes.filter((p, i) => panes.findIndex((q) => q.title === p.title) === i);
  return {
    overlays,
    pane: uniquePanes[0] ?? null,
    panes: uniquePanes,
    note: a.note ?? b.note ?? null,
    rule:
      a.rule && b.rule
        ? `둘 다 켜져 있어야 켜짐 — ① ${a.rule} ② ${b.rule}`
        : a.rule || b.rule || "둘 다 켜져 있으면 켜짐",
  };
}

/** "combo:ma365+macd_w" → ["ma365", "macd_w"]. 조합이 아니면 null. */
function comboMembers(key: string): [string, string] | null {
  if (!key.startsWith(COMBO_PREFIX)) return null;
  const parts = key.slice(COMBO_PREFIX.length).split("+");
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

const C = {
  amber: "#f59e0b",
  purple: "#a78bfa",
  sky: "#38bdf8",
  green: "#34d399",
  red: "#f87171",
  grey: "#8b97a8",
};

/**
 * 패널 선을 캔들 날짜에 맞춰 정렬한다. 값이 없는 자리는 null.
 *
 * 패널 차트는 메인 차트와 '논리 인덱스'로 묶인다(lightweight-charts v4에 진짜 멀티패널이
 * 없어서 쓰는 표준 방법). 그런데 지표 선은 워밍업 구간이 비어 있어 점 개수가 캔들보다
 * 적다 — 월봉 RSI는 앞의 15개월이 없고, 5년치 일봉 차트에서 그건 전체의 25%다.
 * 그대로 넣으면 패널의 0번 점이 캔들 300번째 자리에 놓여 선 전체가 왼쪽으로 밀리고
 * 캔들보다 한참 앞에서 끝나 버린다. 빈 자리를 null로 채워 인덱스를 캔들과 같게 만든다.
 */
export function alignToDates(dates: string[], data: PlotPoint[]): (number | null)[] {
  const byDate = new Map(data.map((p) => [p.date, p.value]));
  return dates.map((d) => {
    const v = byDate.get(d);
    return v == null ? null : v;
  });
}

function dated(bars: EnrichedBar[], values: (number | null)[], label: string, color: string, extra: Partial<PlotLine> = {}): PlotLine {
  const data: PlotPoint[] = [];
  for (let i = 0; i < bars.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) data.push({ date: bars[i].date, value: v });
  }
  return { label, color, data, ...extra };
}

/** 주봉/월봉 지표를 일봉 날짜 위에 계단식으로. 마감된 기간의 값만 쓴다. */
function periodLine(
  bars: EnrichedBar[],
  periodOf: number[],
  values: (number | null)[],
  label: string,
  color: string,
  extra: Partial<PlotLine> = {},
): PlotLine {
  return dated(bars, projectToDaily(periodOf, values, null), label, color, extra);
}

type Ctx = {
  bars: EnrichedBar[];
  closes: number[];
  highs: number[];
  lows: number[];
};

function maOverlay(ctx: Ctx, period: number, color = C.amber): PlotLine {
  return dated(ctx.bars, sma(ctx.closes, period), `${period}일선`, color, { width: 2 });
}

function build(key: string, ctx: Ctx): SignalPlot {
  const { bars, closes, highs, lows } = ctx;
  const none = { overlays: [], pane: null };

  switch (key) {
    // ── 이동평균 ────────────────────────────────────────────────
    case "ma50":
    case "ma120":
    case "ma200":
    case "ma365": {
      const period = Number(key.slice(2));
      return {
        ...none,
        overlays: [maOverlay(ctx, period)],
        rule: `종가가 ${period}일 이동평균선 위에 있으면 켜짐`,
      };
    }
    case "ma200_slope": {
      const ma = sma(closes, 200);
      return {
        ...none,
        overlays: [dated(bars, ma, "200일선", C.amber, { width: 2 })],
        rule: "200일선이 20거래일 전보다 높으면(우상향) 켜짐",
      };
    }
    case "gc_20_60":
      return {
        ...none,
        overlays: [maOverlay(ctx, 20, C.amber), maOverlay(ctx, 60, C.purple)],
        rule: "20일선이 60일선 위에 있으면 켜짐 (골든크로스 상태)",
      };
    case "gc_50_200":
      return {
        ...none,
        overlays: [maOverlay(ctx, 50, C.amber), maOverlay(ctx, 200, C.purple)],
        rule: "50일선이 200일선 위에 있으면 켜짐 (정통 골든크로스 상태)",
      };
    case "ichimoku": {
      const ic = ichimoku(bars);
      return {
        ...none,
        overlays: [
          dated(bars, ic.cloudTop, "구름 상단", C.green),
          dated(bars, ic.cloudBottom, "구름 하단", C.red),
          dated(bars, ic.conversion, "전환선", C.sky, { dashed: true, width: 1 }),
          dated(bars, ic.base, "기준선", C.purple, { dashed: true, width: 1 }),
        ],
        rule: "종가가 구름(선행스팬 A·B) 위에 있으면 켜짐",
      };
    }

    // ── 주봉 / 월봉 ─────────────────────────────────────────────
    case "w_ma30":
    case "w_ma50":
    case "w_ma200": {
      const period = Number(key.slice(4));
      const w = toWeekly(bars);
      const line = sma(w.bars.map((b) => b.close), period);
      return {
        ...none,
        overlays: [periodLine(bars, w.periodOf, line, `${period}주선`, C.amber, { width: 2 })],
        rule: `주봉 종가가 ${period}주 이동평균 위에 있으면 켜짐 (그 주가 마감된 뒤 반영)`,
      };
    }
    case "m_ma12": {
      const m = toMonthly(bars);
      const line = sma(m.bars.map((b) => b.close), 12);
      return {
        ...none,
        overlays: [periodLine(bars, m.periodOf, line, "12개월선", C.amber, { width: 2 })],
        rule: "월봉 종가가 12개월 이동평균 위에 있으면 켜짐 (그 달이 마감된 뒤 반영)",
      };
    }

    // ── MACD ───────────────────────────────────────────────────
    case "macd_d":
    case "macd_d_zero": {
      const m = macd(closes);
      return {
        overlays: [],
        pane: {
          title: "MACD (12, 26, 9)",
          lines: [
            dated(bars, m.macd, "MACD", C.sky, { width: 2 }),
            dated(bars, m.signal, "시그널", C.amber),
          ],
          levels: [{ value: 0, label: "0" }],
        },
        rule:
          key === "macd_d"
            ? "MACD가 시그널선 위에 있으면 켜짐"
            : "MACD가 0선 위에 있으면 켜짐",
      };
    }
    case "macd_w": {
      const w = toWeekly(bars);
      const m = macd(w.bars.map((b) => b.close));
      return {
        overlays: [],
        pane: {
          title: "주봉 MACD (12, 26, 9)",
          lines: [
            periodLine(bars, w.periodOf, m.macd, "MACD", C.sky, { width: 2 }),
            periodLine(bars, w.periodOf, m.signal, "시그널", C.amber),
          ],
          levels: [{ value: 0, label: "0" }],
        },
        rule: "주봉 MACD가 시그널선 위에 있으면 켜짐 (그 주가 마감된 뒤 반영)",
      };
    }
    case "macd_m": {
      const mo = toMonthly(bars);
      const m = macd(mo.bars.map((b) => b.close));
      return {
        overlays: [],
        pane: {
          title: "월봉 MACD (12, 26, 9)",
          lines: [
            periodLine(bars, mo.periodOf, m.macd, "MACD", C.sky, { width: 2 }),
            periodLine(bars, mo.periodOf, m.signal, "시그널", C.amber),
          ],
          levels: [{ value: 0, label: "0" }],
        },
        rule: "월봉 MACD가 시그널선 위에 있으면 켜짐 (그 달이 마감된 뒤 반영)",
      };
    }

    // ── RSI 계열 ────────────────────────────────────────────────
    case "rsi_d50":
    case "rsi_recover": {
      const r = rsi(closes);
      return {
        overlays: [],
        pane: {
          title: "RSI (14)",
          lines: [dated(bars, r, "RSI", C.sky, { width: 2 })],
          levels:
            key === "rsi_d50"
              ? [{ value: 50, label: "50" }]
              : [
                  { value: 45, label: "45" },
                  { value: 30, label: "30" },
                ],
        },
        rule:
          key === "rsi_d50"
            ? "RSI가 50 위면 켜짐"
            : "최근 60일 안에 RSI 30 이하를 찍었고 지금 45 위면 켜짐",
      };
    }
    case "rsi_w50": {
      const w = toWeekly(bars);
      const r = rsi(w.bars.map((b) => b.close));
      return {
        overlays: [],
        pane: {
          title: "주봉 RSI (14)",
          lines: [periodLine(bars, w.periodOf, r, "주봉 RSI", C.sky, { width: 2 })],
          levels: [{ value: 50, label: "50" }],
        },
        rule: "주봉 RSI가 50 위면 켜짐 (그 주가 마감된 뒤 반영)",
      };
    }

    case "rsi_m50": {
      const mo = toMonthly(bars);
      const r = rsi(mo.bars.map((b) => b.close));
      return {
        overlays: [],
        pane: {
          title: "월봉 RSI (14)",
          lines: [periodLine(bars, mo.periodOf, r, "월봉 RSI", C.sky, { width: 2 })],
          levels: [{ value: 50, label: "50" }],
        },
        rule: "월봉 RSI가 50 위면 켜짐 (그 달이 마감된 뒤 반영)",
      };
    }

    // ── 기타 오실레이터 ─────────────────────────────────────────
    case "stoch": {
      const st = stochastic(bars);
      return {
        overlays: [],
        pane: {
          title: "스토캐스틱 (14, 3, 3)",
          lines: [
            dated(bars, st.k, "%K", C.sky, { width: 2 }),
            dated(bars, st.d, "%D", C.amber),
          ],
          levels: [
            { value: 80, label: "80" },
            { value: 20, label: "20" },
          ],
        },
        rule: "%K가 %D 위에 있으면 켜짐",
      };
    }
    case "cci":
      return {
        overlays: [],
        pane: {
          title: "CCI (20)",
          lines: [dated(bars, cci(bars), "CCI", C.sky, { width: 2 })],
          levels: [
            { value: 100, label: "+100" },
            { value: -100, label: "-100" },
          ],
        },
        rule: "CCI가 -100 위면 켜짐",
      };
    case "adx": {
      const d = adx(bars);
      return {
        overlays: [],
        pane: {
          title: "ADX / DI (14)",
          lines: [
            dated(bars, d.adx, "ADX", C.amber, { width: 2 }),
            dated(bars, d.plusDI, "+DI", C.green),
            dated(bars, d.minusDI, "-DI", C.red),
          ],
          levels: [{ value: 20, label: "20" }],
        },
        rule: "ADX가 20 위이고 +DI가 -DI보다 크면 켜짐",
      };
    }

    // ── 볼린저 ──────────────────────────────────────────────────
    case "bb_mid":
    case "bb_squeeze": {
      const bb = bollinger(closes);
      const overlays = [
        dated(bars, bb.upper, "상단", C.purple, { dashed: true }),
        dated(bars, bb.mid, "중심선(20일)", C.amber, { width: 2 }),
        dated(bars, bb.lower, "하단", C.purple, { dashed: true }),
      ];
      if (key === "bb_mid") {
        return { overlays, pane: null, rule: "종가가 볼린저 중심선(20일선) 위면 켜짐" };
      }
      return {
        overlays,
        pane: {
          title: "밴드폭 (%)",
          lines: [dated(bars, bb.bandwidth, "밴드폭", C.sky, { width: 2 })],
          levels: [],
        },
        rule: "밴드폭이 최근 120일 중 하위 20%로 좁아진 뒤 종가가 상단을 뚫으면 켜짐",
      };
    }

    // ── 수급 ────────────────────────────────────────────────────
    case "obv":
      return {
        overlays: [],
        pane: {
          title: "OBV 20일 기울기",
          lines: [
            dated(bars, bars.map((b) => b.obv_slope_20d), "기울기", C.sky, { width: 2 }),
          ],
          levels: [{ value: 0, label: "0" }],
        },
        rule: "OBV(누적 거래량)의 20일 기울기가 0보다 크면 켜짐",
      };
    case "updown_vol":
      return {
        overlays: [],
        pane: {
          title: "20일 상승/하락 거래량 비율",
          lines: [
            dated(bars, bars.map((b) => b.up_down_vol_ratio_20d), "비율", C.sky, { width: 2 }),
          ],
          levels: [{ value: 1.2, label: "1.2" }, { value: 1, label: "1.0" }],
        },
        rule: "최근 20일 상승일 거래량 ÷ 하락일 거래량이 1.2를 넘으면 켜짐",
      };
    case "vol_surge":
      return {
        overlays: [],
        pane: {
          title: "거래량 / 20일 평균",
          lines: [
            dated(bars, bars.map((b) => b.volume_ratio_20d), "배수", C.sky, { width: 2 }),
          ],
          levels: [{ value: 2, label: "2배" }],
        },
        rule: "거래량이 20일 평균의 2배 이상이고 종가가 전일보다 높으면 켜짐",
      };

    // ── 가격 구조 ───────────────────────────────────────────────
    case "high_52w":
      return {
        ...none,
        overlays: [
          dated(bars, rollingMax(highs, 252), "52주 최고가", C.amber, { width: 2 }),
        ],
        rule: "그날 고가가 52주(252거래일) 최고가를 새로 찍으면 켜짐",
      };
    case "off_low_20": {
      const low = rollingMin(lows, 252);
      return {
        ...none,
        overlays: [
          dated(bars, low, "52주 최저가", C.red, { dashed: true }),
          dated(bars, low.map((v) => (v == null ? null : v * 1.2)), "저점 +20%", C.amber, { width: 2 }),
        ],
        rule: "종가가 52주 최저가보다 20% 이상 높으면 켜짐",
      };
    }
    case "hh_hl":
      return {
        ...none,
        overlays: [
          dated(bars, rollingMax(highs, 60), "60일 고점", C.green),
          dated(bars, rollingMin(lows, 60), "60일 저점", C.red),
        ],
        rule: "최근 60일 고점과 저점이 그 이전 60일보다 둘 다 높으면 켜짐",
      };

    case "fund_neg": {
      const f7 = bars.map((b, i) => {
        if (i < 6) return null;
        let sum = 0;
        for (let k = i - 6; k <= i; k++) {
          const v = bars[k].funding_pct;
          if (v == null || !Number.isFinite(v)) return null;
          sum += v;
        }
        return sum / 7;
      });
      return {
        overlays: [],
        pane: {
          title: "펀딩비 7일 평균 (%)",
          lines: [
            dated(bars, bars.map((b) => b.funding_pct), "일별", C.grey, { width: 1 }),
            dated(bars, f7, "7일 평균", C.sky, { width: 2 }),
          ],
          levels: [{ value: 0, label: "0" }],
        },
        rule: "펀딩비 7일 평균이 0 아래면 켜짐 (숏이 롱에게 수수료를 내는 상태)",
      };
    }
    case "fund_washed":
    case "fund_reset":
      return {
        overlays: [],
        pane: {
          title: "펀딩비 60일 z-점수",
          lines: [dated(bars, bars.map((b) => b.funding_zscore_60d), "z-점수", C.sky, { width: 2 })],
          levels: [
            { value: 0, label: "0" },
            { value: -1, label: "-1" },
          ],
        },
        rule:
          key === "fund_washed"
            ? "펀딩비가 최근 60일 평균보다 1표준편차 아래면 켜짐"
            : "60일 안에 z ≤ -1을 찍은 뒤 z가 0 위로 올라오면 켜짐",
      };

    default:
      return { ...none, rule: "" };
  }
}

/** 지표 하나의 그림. bars는 원본 일봉(OHLCV). */
export function plotForSignal(key: string, bars: EnrichedBar[]): SignalPlot {
  const members = comboMembers(key);
  if (members) {
    return mergePlots(plotForSignal(members[0], bars), plotForSignal(members[1], bars));
  }
  return build(key, {
    bars,
    closes: bars.map((b) => b.close),
    highs: bars.map((b) => b.high),
    lows: bars.map((b) => b.low),
  });
}

/**
 * 주봉/월봉 전용 키를 그 봉 위에서 계산할 일봉 키로 바꾼다.
 * 주봉 화면에서 "30주선"은 이미 주봉이니 SMA(30)이면 된다.
 */
const VIEW_ALIAS: Record<string, string> = {
  w_ma30: "ma30",
  w_ma50: "ma50",
  w_ma200: "ma200",
  m_ma12: "ma12",
  macd_w: "macd_d",
  macd_m: "macd_d",
  rsi_w50: "rsi_d50",
  rsi_m50: "rsi_d50",
};

/**
 * 선택한 봉 기준의 그림. 성적표 채점은 일봉 그대로 두고, 차트만 이 봉으로 본다.
 * 주봉/월봉에서는 같은 공식을 그 봉에 그대로 돌린다 (TradingView에서 봉을 바꿨을 때와 같음).
 */
/** 펀딩비는 8시간 정산값을 일 단위로 묶은 것이라 주봉·월봉으로 다시 묶지 않는다. */
const DAILY_ONLY = new Set(["fund_neg", "fund_washed", "fund_reset"]);

export function plotForView(key: string, dailyBars: EnrichedBar[], tf: ChartTf): SignalPlot {
  if (tf === "1d" || DAILY_ONLY.has(key)) return plotForSignal(key, dailyBars);
  const members = comboMembers(key);
  if (members) {
    return mergePlots(
      plotForView(members[0], dailyBars, tf),
      plotForView(members[1], dailyBars, tf),
    );
  }
  const period = tf === "1w" ? toWeekly(dailyBars) : toMonthly(dailyBars);
  const bars = enrich(period.bars);
  const nativeKey = VIEW_ALIAS[key] ?? key;
  const plot = buildOn(nativeKey, bars, CHART_TF_UNIT[tf]);
  return { ...plot, note: viewNote(plot, CHART_TF_LABEL[tf], bars.length) };
}

/**
 * 주/월봉 보기에서 화면에 같이 띄울 경고.
 *
 * 이 화면은 지표를 '그 봉에서 다시 계산'한다(TradingView에서 봉을 바꾼 것과 같다).
 * 그래서 200일선을 고르고 월봉으로 바꾸면 그림은 200개월선이 되는데, 성적표의
 * 켜짐/꺼짐은 여전히 일봉 200일선으로 판정한 값이다. 둘이 다르다는 걸 안 적어 두면
 * "차트에선 선 위인데 신호는 안 떴다"가 된다.
 *
 * 게다가 월봉 200개는 약 17년이라 20년치를 받아도 선이 몇 점 안 나오고,
 * 화면 기간을 줄이면 아예 0점이 된다. 빈 차트는 사용자에게 '고장'으로 보인다.
 */
function viewNote(plot: SignalPlot, tfLabel: string, barCount: number): string {
  const lines = [...plot.overlays, ...(plot.panes ?? (plot.pane ? [plot.pane] : [])).flatMap((p) => p.lines)];
  const drawable = lines.filter((l) => l.data.length > 0);
  const base = `차트만 ${tfLabel}으로 다시 계산한 선입니다. 성적표의 켜짐/꺼짐은 일봉 기준 그대로입니다.`;
  if (!lines.length || drawable.length) return base;
  return `${base} ${tfLabel} ${barCount}개로는 이 지표를 그릴 수 없습니다 — 일봉으로 보세요.`;
}

function maOn(ctx: Ctx, period: number, unit: string, color = C.amber): PlotLine {
  return dated(ctx.bars, sma(ctx.closes, period), `${period}${unit}선`, color, { width: 2 });
}

/** 이미 주봉/월봉으로 묶인 시계열 위에서 그린다. toWeekly를 다시 부르지 않는다. */
function buildOn(key: string, bars: EnrichedBar[], unit: string): SignalPlot {
  const ctx: Ctx = {
    bars,
    closes: bars.map((b) => b.close),
    highs: bars.map((b) => b.high),
    lows: bars.map((b) => b.low),
  };
  const { closes, highs, lows } = ctx;
  const none = { overlays: [], pane: null };
  const maMatch = key.match(/^ma(\d+)$/);
  if (maMatch) {
    const period = Number(maMatch[1]);
    return {
      ...none,
      overlays: [maOn(ctx, period, unit)],
      rule: `종가가 ${period}${unit} 이동평균선 위에 있으면 켜짐`,
    };
  }

  switch (key) {
    case "ma200_slope": {
      const ma = sma(closes, 200);
      return {
        ...none,
        overlays: [dated(bars, ma, `200${unit}선`, C.amber, { width: 2 })],
        rule: `200${unit}선이 20봉 전보다 높으면(우상향) 켜짐`,
      };
    }
    case "gc_20_60":
      return {
        ...none,
        overlays: [maOn(ctx, 20, unit, C.amber), maOn(ctx, 60, unit, C.purple)],
        rule: `20${unit}선이 60${unit}선 위에 있으면 켜짐 (골든크로스 상태)`,
      };
    case "gc_50_200":
      return {
        ...none,
        overlays: [maOn(ctx, 50, unit, C.amber), maOn(ctx, 200, unit, C.purple)],
        rule: `50${unit}선이 200${unit}선 위에 있으면 켜짐 (정통 골든크로스 상태)`,
      };
    case "ichimoku": {
      const ic = ichimoku(bars);
      return {
        ...none,
        overlays: [
          dated(bars, ic.cloudTop, "구름 상단", C.green),
          dated(bars, ic.cloudBottom, "구름 하단", C.red),
          dated(bars, ic.conversion, "전환선", C.sky, { dashed: true, width: 1 }),
          dated(bars, ic.base, "기준선", C.purple, { dashed: true, width: 1 }),
        ],
        rule: "종가가 구름(선행스팬 A·B) 위에 있으면 켜짐",
      };
    }
    case "macd_d":
    case "macd_d_zero": {
      const m = macd(closes);
      return {
        overlays: [],
        pane: {
          title: `MACD (12, 26, 9) · ${unit}봉`,
          lines: [
            dated(bars, m.macd, "MACD", C.sky, { width: 2 }),
            dated(bars, m.signal, "시그널", C.amber),
          ],
          levels: [{ value: 0, label: "0" }],
        },
        rule: key === "macd_d" ? "MACD가 시그널선 위에 있으면 켜짐" : "MACD가 0선 위에 있으면 켜짐",
      };
    }
    case "rsi_d50":
    case "rsi_recover": {
      const r = rsi(closes);
      return {
        overlays: [],
        pane: {
          title: `RSI (14) · ${unit}봉`,
          lines: [dated(bars, r, "RSI", C.sky, { width: 2 })],
          levels:
            key === "rsi_d50"
              ? [{ value: 50, label: "50" }]
              : [
                  { value: 45, label: "45" },
                  { value: 30, label: "30" },
                ],
        },
        rule: key === "rsi_d50" ? "RSI가 50 위면 켜짐" : "최근 60봉 안에 RSI 30 이하를 찍었고 지금 45 위면 켜짐",
      };
    }
    case "stoch": {
      const st = stochastic(bars);
      return {
        overlays: [],
        pane: {
          title: `스토캐스틱 (14, 3, 3) · ${unit}봉`,
          lines: [
            dated(bars, st.k, "%K", C.sky, { width: 2 }),
            dated(bars, st.d, "%D", C.amber),
          ],
          levels: [
            { value: 80, label: "80" },
            { value: 20, label: "20" },
          ],
        },
        rule: "%K가 %D 위에 있으면 켜짐",
      };
    }
    case "cci":
      return {
        overlays: [],
        pane: {
          title: `CCI (20) · ${unit}봉`,
          lines: [dated(bars, cci(bars), "CCI", C.sky, { width: 2 })],
          levels: [
            { value: 100, label: "+100" },
            { value: -100, label: "-100" },
          ],
        },
        rule: "CCI가 -100 위면 켜짐",
      };
    case "adx": {
      const d = adx(bars);
      return {
        overlays: [],
        pane: {
          title: `ADX / DI (14) · ${unit}봉`,
          lines: [
            dated(bars, d.adx, "ADX", C.amber, { width: 2 }),
            dated(bars, d.plusDI, "+DI", C.green),
            dated(bars, d.minusDI, "-DI", C.red),
          ],
          levels: [{ value: 20, label: "20" }],
        },
        rule: "ADX가 20 위이고 +DI가 -DI보다 크면 켜짐",
      };
    }
    case "bb_mid":
    case "bb_squeeze": {
      const bb = bollinger(closes);
      const overlays = [
        dated(bars, bb.upper, "상단", C.purple, { dashed: true }),
        dated(bars, bb.mid, `중심선(20${unit})`, C.amber, { width: 2 }),
        dated(bars, bb.lower, "하단", C.purple, { dashed: true }),
      ];
      if (key === "bb_mid") {
        return { overlays, pane: null, rule: `종가가 볼린저 중심선(20${unit}선) 위면 켜짐` };
      }
      return {
        overlays,
        pane: {
          title: "밴드폭 (%)",
          lines: [dated(bars, bb.bandwidth, "밴드폭", C.sky, { width: 2 })],
          levels: [],
        },
        rule: "밴드폭이 최근 120봉 중 하위 20%로 좁아진 뒤 종가가 상단을 뚫으면 켜짐",
      };
    }
    case "obv":
      return {
        overlays: [],
        pane: {
          title: "OBV 20봉 기울기",
          lines: [dated(bars, bars.map((b) => b.obv_slope_20d), "기울기", C.sky, { width: 2 })],
          levels: [{ value: 0, label: "0" }],
        },
        rule: "OBV(누적 거래량)의 20봉 기울기가 0보다 크면 켜짐",
      };
    case "updown_vol":
      return {
        overlays: [],
        pane: {
          title: "20봉 상승/하락 거래량 비율",
          lines: [dated(bars, bars.map((b) => b.up_down_vol_ratio_20d), "비율", C.sky, { width: 2 })],
          levels: [
            { value: 1.2, label: "1.2" },
            { value: 1, label: "1.0" },
          ],
        },
        rule: "최근 20봉 상승 거래량 ÷ 하락 거래량이 1.2를 넘으면 켜짐",
      };
    case "vol_surge":
      return {
        overlays: [],
        pane: {
          title: "거래량 / 20봉 평균",
          lines: [dated(bars, bars.map((b) => b.volume_ratio_20d), "배수", C.sky, { width: 2 })],
          levels: [{ value: 2, label: "2배" }],
        },
        rule: "거래량이 20봉 평균의 2배 이상이고 종가가 이전 봉보다 높으면 켜짐",
      };
    case "high_52w": {
      const look = unit === "주" ? 52 : unit === "개월" ? 12 : 252;
      return {
        ...none,
        overlays: [dated(bars, rollingMax(highs, look), `${look}봉 최고가`, C.amber, { width: 2 })],
        rule: `그날 고가가 ${look}봉 최고가를 새로 찍으면 켜짐`,
      };
    }
    case "off_low_20": {
      const look = unit === "주" ? 52 : unit === "개월" ? 12 : 252;
      const low = rollingMin(lows, look);
      return {
        ...none,
        overlays: [
          dated(bars, low, `${look}봉 최저가`, C.red, { dashed: true }),
          dated(bars, low.map((v) => (v == null ? null : v * 1.2)), "저점 +20%", C.amber, { width: 2 }),
        ],
        rule: `종가가 ${look}봉 최저가보다 20% 이상 높으면 켜짐`,
      };
    }
    case "hh_hl":
      return {
        ...none,
        overlays: [
          dated(bars, rollingMax(highs, 60), "60봉 고점", C.green),
          dated(bars, rollingMin(lows, 60), "60봉 저점", C.red),
        ],
        rule: "최근 60봉 고점과 저점이 그 이전 60봉보다 둘 다 높으면 켜짐",
      };
    default:
      return { ...none, rule: "" };
  }
}

/** 서버가 보낸 OHLCV를 지표 계산용으로 한 번만 가공한다. */
export { enrich as enrichForPlot };

