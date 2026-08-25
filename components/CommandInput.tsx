"use client";

import { PRESET_CHIPS } from "@/lib/presets";

type Props = {
  value: string;
  onChange: (v: string) => void;
};

export default function CommandInput({ value, onChange }: Props) {
  const selected = PRESET_CHIPS.find((chip) => chip.command === value) ?? null;

  return (
    <div>
      <label htmlFor="command" className="block text-sm font-medium text-muted mb-1.5">
        무엇을 찾을까요?
      </label>
      <textarea
        id="command"
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="예: 거래량은 늘었는데 주가는 거의 안 움직인 날"
        className="w-full rounded-xl bg-surface border border-border px-4 py-3 outline-none
                   focus:border-muted resize-none leading-relaxed"
      />

      <div className="mt-3 flex flex-wrap gap-2">
        {PRESET_CHIPS.map((chip) => {
          const on = selected?.key === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => onChange(chip.command)}
              aria-pressed={on}
              className={`rounded-full border px-3.5 py-2 text-sm transition active:scale-95 ${
                on
                  ? "border-blue-400 bg-blue-500/15 text-white"
                  : "border-border bg-surface text-muted"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {selected?.lookahead ? (
        <p className="mt-2 text-xs text-amber-300/90">
          이 신호는 이후에 실제로 올랐던 날만 골라내는 과거 검증용입니다.
        </p>
      ) : null}
    </div>
  );
}
