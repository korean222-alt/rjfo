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
        placeholder="예: 20일 평균 대비 거래량 2.0배 이상이고 종가 변동이 ±2.0% 이내인 날"
        className="w-full rounded-xl bg-surface border border-border px-4 py-3 outline-none
                   focus:border-muted resize-none leading-relaxed"
      />

      <section className="mt-4" aria-label="빠른 신호 선택">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">빠른 신호 선택</p>
          <p className="text-xs text-muted">선택하면 위 명령이 바뀝니다</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {PRESET_CHIPS.map((chip) => {
            const selected = value === chip.command;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => onChange(chip.command)}
                aria-pressed={selected}
                className={`rounded-xl border px-3 py-3 text-left transition active:scale-[0.98] ${
                  selected
                    ? "border-blue-400 bg-blue-500/15"
                    : "border-border bg-surface hover:border-muted"
                }`}
              >
                <span className="block text-sm font-semibold">{chip.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted">{chip.hint}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
