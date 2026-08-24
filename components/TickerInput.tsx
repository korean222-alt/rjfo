"use client";

type Props = {
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
};

export default function TickerInput({ value, onChange, error }: Props) {
  return (
    <div>
      <label htmlFor="ticker" className="block text-sm font-medium text-muted mb-1.5">
        티커
      </label>
      <input
        id="ticker"
        value={value}
        // 대문자 자동 변환
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        placeholder="AAPL"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        className={`w-full rounded-xl bg-surface border px-4 py-3 tracking-widest font-semibold outline-none transition
          ${error ? "border-down" : "border-border focus:border-muted"}`}
      />
      {error ? <p className="mt-1.5 text-sm text-down">{error}</p> : null}
    </div>
  );
}
