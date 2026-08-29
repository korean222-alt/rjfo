"use client";

import { CHART_TFS, CHART_TF_LABEL, type ChartTf } from "@/lib/cycle/resample";

type Props = {
  value: ChartTf;
  onChange: (tf: ChartTf) => void;
};

export default function TimeframeSelect({ value, onChange }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="차트 봉"
      className="flex rounded-lg border border-border bg-bg p-0.5"
    >
      {CHART_TFS.map((tf) => {
        const active = tf === value;
        return (
          <button
            key={tf}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(tf)}
            className={`min-w-[3.4rem] rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition ${
              active ? "bg-blue-500 text-white" : "text-muted active:bg-surface"
            }`}
          >
            {CHART_TF_LABEL[tf]}
          </button>
        );
      })}
    </div>
  );
}
