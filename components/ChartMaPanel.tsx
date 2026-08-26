"use client";

import { useEffect, useState } from "react";
import { MAX_MA_PERIOD, clampPeriod } from "@/lib/ma";

const PRESETS = [20, 60, 120, 200, 365];

type Props = {
  periods: number[];
  onChange: (periods: number[]) => void;
};

export default function ChartMaPanel({ periods, onChange }: Props) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText("");
  }, [focused, periods]);

  function add(period: number) {
    const n = clampPeriod(period, 20);
    if (periods.includes(n)) return;
    onChange([...periods, n].sort((a, b) => a - b));
  }

  function toggle(period: number) {
    if (periods.includes(period)) onChange(periods.filter((p) => p !== period));
    else add(period);
  }

  function submitCustom() {
    const n = Number(text);
    if (Number.isFinite(n) && n > 0) add(n);
    setText("");
    setFocused(false);
  }

  return (
    <section className="rounded-2xl border border-border bg-surface p-4" aria-label="차트 이평선">
      <p className="text-sm font-medium">이평선 차트에 추가</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        누르면 바로 차트에 그려집니다. 분석을 다시 하지 않아도 됩니다.
      </p>

      <div className="mt-3 grid grid-cols-5 gap-1.5">
        {PRESETS.map((p) => {
          const on = periods.includes(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => toggle(p)}
              aria-pressed={on}
              className={`rounded-lg border py-2 text-xs font-semibold tabular-nums transition ${
                on ? "border-amber-400 bg-amber-500/15 text-amber-200" : "border-border bg-bg text-muted"
              }`}
            >
              {p}
            </button>
          );
        })}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitCustom();
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={text}
          placeholder={`직접 입력 (2–${MAX_MA_PERIOD})`}
          onFocus={() => {
            setFocused(true);
            setText("");
          }}
          onChange={(e) => setText(e.target.value.replace(/\D/g, "").slice(0, 3))}
          onBlur={() => {
            if (text) submitCustom();
            else setFocused(false);
          }}
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm tabular-nums outline-none focus:border-muted"
        />
        <button type="submit" className="shrink-0 rounded-lg bg-blue-500 px-3 py-2 text-sm font-bold text-white">
          추가
        </button>
      </form>

      {periods.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {periods.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => toggle(p)}
              className="rounded-full border border-amber-400/50 bg-amber-500/10 px-2.5 py-1 text-xs tabular-nums text-amber-200"
            >
              MA{p} ×
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">아직 켠 이평선이 없습니다.</p>
      )}
    </section>
  );
}
