/**
 * 월봉 지표가 실제로 효과가 있는지 실데이터로 검산한다.
 *   npx tsx scripts/backtest-monthly.ts
 *   npx tsx scripts/backtest-monthly.ts --file ./sp500.csv   # 받아둔 CSV로
 *
 * 왜 이 스크립트가 따로 있나:
 *   화면의 성적표는 '한 종목 20년'을 본다. 그런데 월봉 지표는 20년이면 표본이
 *   240개뿐이고, 상승장 전환은 대여섯 번이다. 그 정도로는 "이 지표가 효과가 있다"를
 *   말할 수 없다. 그래서 같은 지표를 155년치 S&P 500 월봉(1,860개월)에 그대로 걸어
 *   기저율과 비교한다. 표본이 8배 가까이 늘면 우연으로 좋아 보일 여지가 그만큼 줄어든다.
 *
 * 데이터: Robert Shiller의 S&P Composite 월별 시계열 (datasets/s-and-p-500).
 *   주의 — 이 시계열의 가격은 그 달 '일별 종가의 평균'이다. 월말 종가가 아니다.
 *   평균이라 실제보다 매끄럽고 반 달쯤 늦다. 그래서 여기 수치는 월말 종가로 다시
 *   계산한 것과 정확히 같지 않다. 방향과 규모를 보는 용도다.
 *   배당은 빠져 있다(가격 지수). 수수료·세금·슬리피지도 없다.
 *
 * 지표는 앱과 같은 코드(lib/cycle/ta.ts)를 그대로 쓴다. 여기서만 다르게 짜면
 * 검산이 아니라 다른 프로그램을 만든 것이 된다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rsi, sma } from "../lib/cycle/ta";

const URL = "https://raw.githubusercontent.com/datasets/s-and-p-500/main/data/data.csv";

/** 전방 수익률을 재는 지점 (개월). */
const HORIZONS = [1, 3, 6, 12] as const;

async function download(): Promise<string> {
  const fileArg = process.argv.indexOf("--file");
  if (fileArg >= 0 && process.argv[fileArg + 1]) return readFileSync(process.argv[fileArg + 1], "utf8");
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    // 프록시 뒤에서는 fetch가 막히고 curl만 되는 환경이 있다.
    return execFileSync("curl", ["-sS", "--max-time", "60", URL], { encoding: "utf8", maxBuffer: 64 << 20 });
  }
}

type Row = { date: string; close: number };

function parse(csv: string): Row[] {
  const lines = csv.trim().split("\n");
  const head = lines[0].split(",");
  const iDate = head.indexOf("Date");
  const iClose = head.indexOf("SP500");
  const out: Row[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const close = Number(cells[iClose]);
    if (!Number.isFinite(close) || close <= 0) continue;
    out.push({ date: cells[iDate], close });
  }
  return out;
}

function mean(v: number[]): number | null {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function median(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const f = (v: number | null, d = 2) => (v == null ? "    —" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`);
const pct = (v: number | null, d = 1) => (v == null ? "   —" : `${v.toFixed(d)}%`);

/** 상태 배열에 대한 전방 수익률 통계. */
function statsFor(rets: (number | null)[], state: boolean[], want: boolean) {
  const v: number[] = [];
  for (let i = 0; i < rets.length; i++) {
    if (state[i] === want && rets[i] != null) v.push(rets[i]!);
  }
  return {
    n: v.length,
    avg: mean(v),
    median: median(v),
    winRate: v.length ? (v.filter((x) => x > 0).length / v.length) * 100 : null,
    worst: v.length ? Math.min(...v) : null,
  };
}

/**
 * 순환 이동 검정.
 *
 * 상태 배열(켜짐/꺼짐)을 통째로 옮겨도 이만큼 벌었을지 본다. 월간 수익률은
 * 서로 겹치고(12개월 수익률은 11개월이 겹친다) 상태는 몇 년씩 이어지므로,
 * 각 달을 독립 시행으로 보는 t검정은 확률을 실제보다 훨씬 낮게 부른다.
 * 이동 검정은 그 구조를 그대로 안고 간다.
 */
function shiftP(rets: (number | null)[], state: boolean[]): number | null {
  const n = state.length;
  const observed = statsFor(rets, state, true).avg;
  if (observed == null) return null;
  let tried = 0;
  let atLeast = 0;
  for (let s = 0; s < n; s++) {
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (!state[i]) continue;
      const j = (i + s) % n;
      const r = rets[j];
      if (r != null) {
        sum += r;
        cnt++;
      }
    }
    if (!cnt) continue;
    tried++;
    if (sum / cnt >= observed) atLeast++;
  }
  return tried ? atLeast / tried : null;
}

/** 켜져 있을 때만 들고 가는 전략의 자산 곡선. 꺼지면 현금(수익 0). */
function equity(rows: Row[], state: boolean[]) {
  let value = 1;
  let peak = 1;
  let maxDD = 0;
  let months = 0;
  let inMarket = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i].close / rows[i - 1].close - 1;
    // i-1월 말에 결정한 상태로 i월을 보낸다 (미래 참조 없음).
    if (state[i - 1]) {
      value *= 1 + r;
      inMarket++;
    }
    months++;
    peak = Math.max(peak, value);
    maxDD = Math.min(maxDD, value / peak - 1);
  }
  const years = months / 12;
  return {
    cagr: (Math.pow(value, 1 / years) - 1) * 100,
    maxDD: maxDD * 100,
    inMarketPct: (inMarket / months) * 100,
    multiple: value,
  };
}

function forwardReturns(rows: Row[], months: number): (number | null)[] {
  return rows.map((r, i) =>
    i + months < rows.length ? (rows[i + months].close / r.close - 1) * 100 : null,
  );
}

function reportState(name: string, rows: Row[], state: boolean[], warmup: number) {
  // 워밍업 구간은 상태를 못 정하므로 통계에서 빼야 한다.
  const usable = state.map((v, i) => (i < warmup ? null : v));
  const on = usable.map((v) => v === true);
  const off = usable.map((v) => v === false);
  const all = usable.map((v) => v != null);

  console.log(`\n■ ${name}`);
  console.log(
    `  켜져 있던 기간: ${((on.filter(Boolean).length / all.filter(Boolean).length) * 100).toFixed(1)}%` +
      ` (${on.filter(Boolean).length}개월 / ${all.filter(Boolean).length}개월)`,
  );
  console.log("  구간   상태     표본     평균     중앙값   상승비율   최악");
  for (const h of HORIZONS) {
    const rets = forwardReturns(rows, h);
    const masked = rets.map((r, i) => (usable[i] == null ? null : r));
    const onS = statsFor(masked, on, true);
    const offS = statsFor(masked, off, true);
    const baseS = statsFor(masked, all, true);
    const line = (label: string, s: ReturnType<typeof statsFor>) =>
      `  ${String(h).padStart(2)}개월 ${label.padEnd(6)} ${String(s.n).padStart(5)}` +
      `  ${f(s.avg).padStart(7)}%  ${f(s.median).padStart(7)}%  ${pct(s.winRate).padStart(7)}` +
      `  ${f(s.worst, 1).padStart(7)}%`;
    console.log(line("켜짐", onS));
    console.log(line("꺼짐", offS));
    console.log(
      line("전체(기저)", baseS) +
        `   → 켜짐−기저 ${f(onS.avg != null && baseS.avg != null ? onS.avg - baseS.avg : null)}%p`,
    );
  }

  const p = shiftP(forwardReturns(rows, 12).map((r, i) => (usable[i] == null ? null : r)), on);
  console.log(`  12개월 수익률 기준 우연일 확률(순환 이동 검정): ${p == null ? "—" : (p * 100).toFixed(1) + "%"}`);

  const eq = equity(rows, on);
  return eq;
}

async function main() {
  const rows = parse(await download());
  console.log(
    `\nS&P 500 월봉 ${rows.length}개월 (${rows[0].date} ~ ${rows[rows.length - 1].date}, 약 ${(rows.length / 12).toFixed(0)}년)`,
  );
  console.log("가격은 Shiller 시계열의 월별 평균가(배당 제외). 수수료·세금 없음.\n");

  const closes = rows.map((r) => r.close);
  const r14 = rsi(closes, 14);
  const ma10 = sma(closes, 10);

  const rsiOn = r14.map((v) => v != null && v > 50);
  const maOn = ma10.map((v, i) => v != null && closes[i] > v);
  const comboOn = rsiOn.map((v, i) => v && maOn[i]);

  const eqRsi = reportState("월봉 RSI(14) > 50", rows, rsiOn, 15);
  const eqMa = reportState("종가 > 10개월선 (200일선의 월봉 판)", rows, maOn, 11);
  const eqCombo = reportState("둘 다 (RSI>50 + 10개월선 위)", rows, comboOn, 15);

  const bh = equity(rows, rows.map(() => true));
  console.log("\n■ 그래서 돈이 되나 (켜져 있을 때만 보유, 꺼지면 현금 0%)");
  console.log("  전략                       연복리   최대낙폭   시장에 있던 기간   최종배수");
  const row = (name: string, e: ReturnType<typeof equity>) =>
    `  ${name.padEnd(24)} ${e.cagr.toFixed(2).padStart(6)}%  ${e.maxDD.toFixed(1).padStart(7)}%` +
    `  ${e.inMarketPct.toFixed(1).padStart(12)}%  ${e.multiple.toFixed(0).padStart(8)}배`;
  console.log(row("사서 계속 들고 있기", bh));
  console.log(row("월봉 RSI > 50", eqRsi));
  console.log(row("10개월선 위", eqMa));
  console.log(row("둘 다", eqCombo));

  // 시대를 갈라 본다. 한 시대에만 통한 규칙이면 그건 발견이 아니다.
  console.log("\n■ 시대별 (연복리 %, 사서 들고 있기 대비)");
  const eras: [string, string, string][] = [
    ["1881-1920", "1881-01-01", "1920-12-01"],
    ["1921-1960", "1921-01-01", "1960-12-01"],
    ["1961-2000", "1961-01-01", "2000-12-01"],
    ["2001-현재", "2001-01-01", "9999-12-01"],
  ];
  console.log("  기간         사서보유   RSI>50   10개월선    둘 다");
  for (const [label, from, to] of eras) {
    const idx = rows.map((r, i) => i).filter((i) => rows[i].date >= from && rows[i].date <= to);
    if (idx.length < 60) continue;
    const slice = idx.map((i) => rows[i]);
    const cut = (st: boolean[]) => idx.map((i) => st[i]);
    const e = (st: boolean[]) => equity(slice, st).cagr;
    console.log(
      `  ${label.padEnd(11)} ${e(cut(rows.map(() => true))).toFixed(2).padStart(7)}%` +
        ` ${e(cut(rsiOn)).toFixed(2).padStart(7)}%` +
        ` ${e(cut(maOn)).toFixed(2).padStart(8)}%` +
        ` ${e(cut(comboOn)).toFixed(2).padStart(8)}%`,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(`실패: ${(e as Error).message}`);
  process.exit(1);
});
