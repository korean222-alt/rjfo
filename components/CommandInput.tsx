"use client";

import { PRESET_CHIPS } from "@/lib/presets";

type Props = {
  value: string;
  onChange: (v: string) => void;
};

export default function CommandInput({ value, onChange }: Props) {
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
        placeholder="예: 20일 평균 대비 3배 이상 거래량인데 주가는 거의 안 움직인 날"
        className="w-full rounded-xl bg-surface border border-border px-4 py-3 outline-none
                   focus:border-muted resize-none leading-relaxed"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESET_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => onChange(chip.command)}
            className="rounded-full border border-border bg-surface px-3.5 py-2 text-sm
                       text-muted active:scale-95 transition"
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
}
