"use client";

import type { MatchRow } from "@/types";
import { compactNumber, num, pct, returnColor } from "@/lib/format";

export default function MatchList({ matches }: { matches: MatchRow[] }) {
  if (!matches.length) {
    return (
      <p className="rounded-2xl border border-border bg-surface p-5 text-center text-muted">
        조건에 맞는 날이 없습니다.
      </p>
    );
  }

  // 가로 스크롤 테이블 금지 — 카드 리스트로
  return (
    <ul className="space-y-2">
      {matches.map((m) => (
        <li key={m.date} className="rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <span className="font-semibold tabular-nums">
              {m.date}
              {m.rarity == null ? null : (
                <span
                  className="ml-2 rounded-md bg-bg px-1.5 py-0.5 text-[11px] font-medium text-muted"
                  title="이 종목 역사에서 조건 지표들이 얼마나 드문 축인지 (0~100)"
                >
                  희귀도 {m.rarity.toFixed(0)}
                </span>
              )}
            </span>
            <span className={`text-lg font-bold tabular-nums ${returnColor(m.forwardReturns.d20)}`}>
              {pct(m.forwardReturns.d20)}
              <span className="ml-1 text-xs font-normal text-muted">20일</span>
            </span>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Cell label="거래량" value={compactNumber(m.volume)} />
            <Cell
              label="평소 대비"
              value={m.volumeRatio == null ? "—" : `${num(m.volumeRatio)}배`}
            />
            <Cell
              label="당일 변동"
              value={pct(m.closeChangePct)}
              className={returnColor(m.closeChangePct)}
            />
          </div>

          <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
            <Cell label="5일" value={pct(m.forwardReturns.d5)} className={returnColor(m.forwardReturns.d5)} />
            <Cell label="60일" value={pct(m.forwardReturns.d60)} className={returnColor(m.forwardReturns.d60)} />
            <Cell
              label="20일 내 최대"
              value={pct(m.maxForwardReturn20d)}
              className={returnColor(m.maxForwardReturn20d)}
            />
          </div>

          {m.clusterSize && m.clusterSize > 1 ? (
            <p className="mt-2 text-xs text-muted">
              {m.clusterStart} ~ {m.clusterEnd} {m.clusterSize}일을 한 국면으로 묶고 이 날을 대표로 남김
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Cell({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-lg bg-bg px-2.5 py-2">
      <p className="text-[11px] text-muted">{label}</p>
      <p className={`mt-0.5 font-semibold tabular-nums ${className}`}>{value}</p>
    </div>
  );
}
