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
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        placeholder="AAPL · BTC · 005930"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        className={`w-full rounded-xl bg-surface border px-4 py-3 tracking-widest font-semibold outline-none transition
          ${error ? "border-down" : "border-border focus:border-muted"}`}
      />
      <p className="mt-1.5 text-xs text-muted">미국 주식 AAPL, 코인 BTC, 한국 종목 005930 · 삼성전자.</p>
      {error ? <p className="mt-1.5 text-sm text-down">{error}</p> : null}
    </div>
  );
}
