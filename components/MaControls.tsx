"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_LONG_MA,
  DEFAULT_SHORT_MA,
  DEFAULT_TOUCH_MA,
  clampPeriod,
  maCrossCommand,
  maTouchCommand,
  orderedPair,
  parseMaCommand,
} from "@/lib/ma";

const PAIR_PRESETS = [
  { label: "5 / 20", short: 5, long: 20 },
  { label: "20 / 60", short: 20, long: 60 },
  { label: "50 / 200", short: 50, long: 200 },
];

type Mode = "golden" | "death" | "touch" | null;

type Props = {
  value: string;
  onChange: (command: string) => void;
};

function modeOf(command: string): Mode {
  const spec = parseMaCommand(command);
  if (!spec) return null;
  const c = spec.conditions[0];
  if (c?.kind === "ma_touch") return "touch";
  if (c?.kind === "ma_cross") return c.direction;
  return null;
}

export default function MaControls({ value, onChange }: Props) {
  const [short, setShort] = useState(DEFAULT_SHORT_MA);
  const [long, setLong] = useState(DEFAULT_LONG_MA);
  const [touch, setTouch] = useState(DEFAULT_TOUCH_MA);
  const mode = useMemo(() => modeOf(value), [value]);

  useEffect(() => {
    const spec = parseMaCommand(value);
    if (!spec) return;
    const c = spec.conditions[0];
    if (c?.kind === "ma_cross") {
      setShort(c.short);
      setLong(c.long);
    } else if (c?.kind === "ma_touch") {
      setTouch(c.period);
    }
  }, [value]);

  function applyPair(nextShort: number, nextLong: number, nextMode: Mode = mode) {
    const pair = orderedPair(nextShort, nextLong);
    setShort(pair.short);
    setLong(pair.long);
    if (nextMode === "golden" || nextMode === "death") {
      onChange(maCrossCommand(nextMode, pair.short, pair.long));
    }
  }

  function applyTouch(nextPeriod: number, activate = mode === "touch") {
    const period = clampPeriod(nextPeriod, DEFAULT_TOUCH_MA);
    setTouch(period);
    if (activate) onChange(maTouchCommand(period));
  }

  return (
    <section className="mt-4 rounded-xl border border-border bg-surface px-4 py-3" aria-label="이평선 설정">
      <p className="text-sm font-medium">이평선 직접 설정</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        기간을 정한 뒤 골든/데드/터치를 고르면 위 명령이 바뀝니다. 비트코인(BTC)도 같은 조건으로 분석됩니다.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <PeriodField label="단기선" value={short} onChange={(n) => applyPair(n, long)} />
        <PeriodField label="장기선" value={long} onChange={(n) => applyPair(short, n)} />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {PAIR_PRESETS.map((p) => {
          const active = short === p.short && long === p.long;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPair(p.short, p.long, mode === "touch" ? "golden" : mode)}
              aria-pressed={active}
              className={`rounded-lg border py-2 text-xs font-medium tabular-nums transition ${
                active ? "border-blue-400 bg-blue-500/15" : "border-border bg-bg text-muted"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <ModeButton label="골든크로스" pressed={mode === "golden"} onClick={() => onChange(maCrossCommand("golden", short, long))} />
        <ModeButton label="데드크로스" pressed={mode === "death"} onClick={() => onChange(maCrossCommand("death", short, long))} />
        <ModeButton label="이평 터치" pressed={mode === "touch"} onClick={() => applyTouch(touch, true)} />
      </div>

      <label className="mt-3 block">
        <span className="block text-xs text-muted">터치 이평 (일)</span>
        <input
          type="number"
          inputMode="numeric"
          min={2}
          max={500}
          value={touch}
          onChange={(e) => applyTouch(Number(e.target.value), true)}
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm tabular-nums outline-none focus:border-muted"
        />
      </label>
    </section>
  );
}

function PeriodField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  return (
    <label className="block">
      <span className="block text-xs text-muted">{label} (일)</span>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={focused ? text : String(value)}
        onFocus={() => {
          setFocused(true);
          setText("");
        }}
        onChange={(e) => setText(e.target.value.replace(/\D/g, "").slice(0, 3))}
        onBlur={() => {
          setFocused(false);
          const n = Number(text);
          onChange(clampPeriod(Number.isFinite(n) && n > 0 ? n : value));
        }}
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm tabular-nums outline-none focus:border-muted"
      />
    </label>
  );
}

function ModeButton({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`rounded-lg border px-2 py-2 text-xs font-semibold transition active:scale-[0.98] ${
        pressed ? "border-blue-400 bg-blue-500/15" : "border-border bg-bg text-muted"
      }`}
    >
      {label}
    </button>
  );
}
