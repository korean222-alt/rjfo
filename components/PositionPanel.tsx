"use client";

/**
 * '지금 위치' 패널.
 *
 * 등급표 옆에 이게 없으면 화면은 "A등급이 켜져 있다"까지만 말하고 멈춘다. 그런데 그건
 * 방금 켜졌다는 뜻도, 지금 사도 된다는 뜻도 아니다 — 등급의 근거가 된 숫자는 전부
 * '켜지는 날' 기준으로 잰 것이기 때문이다(lib/cycle/position.ts 주석 참고).
 *
 * 그래서 세 가지를 나란히 놓는다: 사이클 진행도, 켜진 지표의 나이, 그리고 그 지표가
 * 꺼질 때까지 기다리면 반납하게 되는 몫.
 */

import type { PositionAssessment, PositionStage } from "@/lib/cycle";

const STAGE_TONE: Record<PositionStage, string> = {
  "하락 국면": "border-down/40 bg-down/10 text-down",
  "고점권 되밀림": "border-down/40 bg-down/10 text-down",
  "과거 중앙값 초과": "border-amber-400/40 bg-amber-400/10 text-amber-300",
  중반: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  초기: "border-up/40 bg-up/10 text-up",
  판정불가: "border-border bg-bg text-muted",
};

const STAGE_HINT: Record<PositionStage, string> = {
  "하락 국면": "직전 고점에서 이미 하락 기준을 넘겨 빠졌습니다.",
  "고점권 되밀림": "이번 사이클 최고가에서 하락 전환선의 절반 넘게 되밀렸습니다.",
  "과거 중앙값 초과": "과거 사이클들의 상승폭 중앙값을 이미 넘겼습니다.",
  중반: "과거 사이클 상승폭 중앙값의 절반 이상 왔습니다.",
  초기: "과거 사이클 상승폭 중앙값에 견주면 아직 초입입니다.",
  판정불가: "비교할 과거 사이클이 부족해 진행도를 잴 수 없습니다.",
};

function pct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg px-3 py-2">
      <p className="text-[10px] text-muted">{label}</p>
      <p className={`text-base font-bold tabular-nums ${tone ?? "text-white"}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-[10px] leading-snug text-muted">{sub}</p> : null}
    </div>
  );
}

export default function PositionPanel({
  position,
  bearPct,
  windowAfter,
}: {
  position: PositionAssessment;
  bearPct: number;
  windowAfter: number;
}) {
  const { cycle, stage, onSignals } = position;
  const progress = cycle.progressPct;
  const over = progress != null && progress > 100;

  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">지금 위치</h2>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STAGE_TONE[stage]}`}>
          {stage}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{STAGE_HINT[stage]}</p>

      {/* ① 사이클 진행도 */}
      {cycle.troughDate ? (
        <>
          <p className="mt-3 text-2xl font-black tabular-nums">
            {pct(cycle.gainPct)}
            <span className="text-base font-medium text-muted">
              {" "}
              · {cycle.troughDate} 바닥 대비
            </span>
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg">
            <div
              className={`h-full transition-all ${over ? "bg-amber-400" : "bg-up"}`}
              style={{ width: `${Math.max(0, Math.min(100, progress ?? 0))}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            {cycle.medianPastGainPct != null && progress != null ? (
              <>
                과거 사이클 상승폭 중앙값 <b className="text-white">{pct(cycle.medianPastGainPct)}</b>의{" "}
                <b className={over ? "text-amber-300" : "text-white"}>{progress.toFixed(0)}%</b> · 끝난 과거 사이클{" "}
                {cycle.pastGains.length}번 중 <b className="text-white">{cycle.exceededCount}번</b>은 이미 넘어섰습니다.
              </>
            ) : (
              "끝난 과거 사이클이 없어 비교할 기준이 없습니다. 상승률만 그대로 보세요."
            )}
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted">라벨링된 사이클이 없어 위치를 잴 수 없습니다.</p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat
          label="이번 사이클 고점 대비"
          value={pct(cycle.fromPeakPct, 1)}
          tone={(cycle.fromPeakPct ?? 0) < 0 ? "text-down" : "text-white"}
          sub={cycle.peakDate ? `${cycle.peakDate} 최고 종가` : undefined}
        />
        <Stat
          label="하락 국면 전환까지"
          value={pct(cycle.furtherDropToBearPct, 1)}
          tone="text-down"
          sub={cycle.furtherDropToBearPct == null ? "이미 하락 국면" : `고점 대비 −${bearPct}% 선`}
        />
        <Stat
          label="지표 꺼질 때까지"
          value={pct(position.medianFurtherDropToExitPct, 1)}
          tone="text-down"
          sub="켜진 상위 등급의 중앙값"
        />
      </div>

      {/* ②③ 켜진 지표의 나이와 반납폭 — 이 패널의 핵심 */}
      {onSignals.length ? (
        <div className="mt-3">
          <p className="text-[11px] leading-relaxed text-muted">
            지금 켜진 지표 <b className="text-white">{onSignals.length}개</b> · 등급을 잰 창(바닥 뒤 {windowAfter}거래일)
            안에 있는 상위 등급 <b className="text-up">{position.freshCount}개</b> · 창을 벗어난 것{" "}
            <b className="text-amber-300">{position.staleCount}개</b>
          </p>
          <div className="mt-2 -mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[520px] text-[11px] tabular-nums">
              <thead className="text-muted">
                <tr className="border-b border-border text-left">
                  <th className="py-1 pr-2 font-medium">지표</th>
                  <th className="py-1 pr-2 font-medium">켜진 지</th>
                  <th className="py-1 pr-2 font-medium">고점 대비 지금</th>
                  <th className="py-1 pr-2 font-medium">과거 꺼진 지점</th>
                  <th className="py-1 font-medium">꺼질 때까지</th>
                </tr>
              </thead>
              <tbody>
                {onSignals.slice(0, 12).map((s) => (
                  <tr key={s.key} className="border-b border-border/50">
                    <td className="max-w-[180px] truncate py-1.5 pr-2">
                      <span className={s.grade === "A" ? "text-up" : "text-muted"}>[{s.grade}]</span>{" "}
                      <span className="text-white">{s.label}</span>
                    </td>
                    <td className={`py-1.5 pr-2 ${s.fresh ? "text-muted" : "text-amber-300"}`}>
                      {s.daysOn}일{s.fresh ? "" : " ⚠"}
                    </td>
                    <td className="py-1.5 pr-2 text-white">{pct(s.givebackNowPct, 1)}</td>
                    <td className="py-1.5 pr-2 text-muted">
                      {s.exitSamples ? `${pct(s.medianExitGivebackPct, 0)} (${s.exitSamples}회)` : "—"}
                    </td>
                    <td className="py-1.5 text-down">{pct(s.furtherDropToExitPct, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
            &lsquo;고점 대비 지금&rsquo;은 그 지표가 켜진 뒤 최고 종가에서 지금까지 반납한 몫입니다.
            &lsquo;과거 꺼진 지점&rsquo;은 과거에 이 지표가 꺼졌을 때 같은 자로 잰 값의 중앙값이고,
            &lsquo;꺼질 때까지&rsquo;는 오늘 종가에서 거기까지 더 빠져야 하는 폭입니다.
          </p>
        </div>
      ) : null}

      {position.notes.length ? (
        <ul className="mt-3 space-y-1.5 border-t border-border pt-3">
          {position.notes.map((n) => (
            <li key={n} className="text-[11px] leading-relaxed text-muted">
              · {n}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
