"use client";

import MaControls from "@/components/MaControls";
import { isFundingSignal, isMaSignal, PRESET_CHIPS } from "@/lib/presets";

type Props = {
  value: string;
  onChange: (v: string) => void;
};

export default function CommandInput({ value, onChange }: Props) {
  const volumeChips = PRESET_CHIPS.filter((chip) => !isMaSignal(chip.key) && !isFundingSignal(chip.key));
  const fundingChips = PRESET_CHIPS.filter((chip) => isFundingSignal(chip.key));

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
        placeholder="예: 이평 20/60 골든크로스, 펀딩 과열"
        className="w-full rounded-xl bg-surface border border-border px-4 py-3 outline-none
                   focus:border-muted resize-none leading-relaxed"
      />

      <MaControls value={value} onChange={onChange} />

      <ChipGrid title="거래량 신호" hint="선택하면 위 명령이 바뀝니다" chips={volumeChips} value={value} onChange={onChange} />
      <ChipGrid
        title="펀딩비 신호 · 코인"
        hint="BTC, ETH처럼 펀딩이 있는 종목만 됩니다"
        chips={fundingChips}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

function ChipGrid({
  title,
  hint,
  chips,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  chips: typeof PRESET_CHIPS;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <section className="mt-4" aria-label={title}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {chips.map((chip) => {
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
  );
}
