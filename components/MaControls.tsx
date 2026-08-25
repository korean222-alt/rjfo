"use client";

import { MA_PERIOD_MAX, MA_PERIOD_MIN, clampPeriod, type MaCross } from "@/lib/ma-cross";
import { pct } from "@/lib/format";
import type { MaSettings } from "@/lib/session";

/** 흔히 쓰는 조합. 사용자가 직접 입력할 수도 있다. */
const MA_PRESETS: { label: string; fast: number; slow: number }[] = [
  { label: "5 / 20", fast: 5, slow: 20 },
  { label: "20 / 60", fast: 20, slow: 60 },
  { label: "50 / 200", fast: 50, slow: 200 },
];

type Props = {
  settings: MaSettings;
  onChange: (next: MaSettings) => void;
  crosses: MaCross[];
};

export default function MaControls({ settings, onChange, crosses }: Props) {
  const invalid = settings.fast >= settings.slow;
  const golden = crosses.filter((c) => c.type === "golden").length;
  const dead = crosses.length - golden;
  const recent = [...crosses].reverse().slice(0, 6);

  return (
    <section className="rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">이동평균선 · 골든/데드크로스</p>
          <p className="text-xs text-muted">두 선이 교차하는 날을 차트에 표시합니다</p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
          className={`h-7 w-12 shrink-0 rounded-full transition ${
            settings.enabled ? "bg-blue-500" : "bg-border"
          }`}
          aria-pressed={settings.enabled}
          aria-label="이동평균선 표시"
        >
          <span
            className={`block h-6 w-6 rounded-full bg-white transition-transform ${
              settings.enabled ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {settings.enabled ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
            <PeriodField
              label="단기선"
              value={settings.fast}
              onChange={(fast) => onChange({ ...settings, fast })}
            />
            <PeriodField
              label="장기선"
              value={settings.slow}
              onChange={(slow) => onChange({ ...settings, slow })}
            />
          </div>

          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {MA_PRESETS.map((p) => {
              const active = settings.fast === p.fast && settings.slow === p.slow;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => onChange({ ...settings, fast: p.fast, slow: p.slow })}
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

          {invalid ? (
            <p className="mt-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
              단기선이 장기선보다 짧아야 교차가 성립합니다. (현재 {settings.fast} ≥ {settings.slow})
            </p>
          ) : (
            <>
              <p className="mt-3 text-xs text-muted">
                골든크로스 <span className="font-semibold text-up">{golden}</span>회 · 데드크로스{" "}
                <span className="font-semibold text-down">{dead}</span>회
              </p>

              {recent.length ? (
                <ul className="mt-2 space-y-1">
                  {recent.map((c) => (
                    <li
                      key={`${c.type}-${c.date}`}
                      className="flex items-center justify-between rounded-lg bg-bg px-2.5 py-1.5 text-xs"
                    >
                      <span className="tabular-nums">
                        <span className={c.type === "golden" ? "text-up" : "text-down"}>
                          {c.type === "golden" ? "▲ 골든" : "▼ 데드"}
                        </span>
                        <span className="ml-2 text-muted">{c.date}</span>
                      </span>
                      <span className="tabular-nums text-muted">
                        이후 20일 {pct(c.forwardReturn20d)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  이 기간에는 {settings.fast}일선과 {settings.slow}일선이 교차한 날이 없습니다.
                </p>
              )}
            </>
          )}
        </>
      ) : null}
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
  return (
    <label className="block">
      <span className="block text-xs text-muted">{label} (일)</span>
      <input
        type="number"
        inputMode="numeric"
        min={MA_PERIOD_MIN}
        max={MA_PERIOD_MAX}
        value={value}
        onChange={(e) => {
          const raw = Number(e.target.value);
          // 입력 도중의 빈 값이나 범위 밖 값은 허용 범위로 다듬어 넣는다.
          onChange(Number.isFinite(raw) ? clampPeriod(raw) : MA_PERIOD_MIN);
        }}
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm tabular-nums outline-none focus:border-muted"
      />
    </label>
  );
}
