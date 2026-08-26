"use client";

import { useState } from "react";
import type { ChartMarker } from "@/components/VolumeChart";
import type { AnalysisPayload } from "@/lib/session";

type Msg = { role: "user" | "assistant"; text: string };

type Props = {
  ticker: string;
  onApplied: (payload: AnalysisPayload, markers: ChartMarker[]) => void;
  onClearMarkers?: () => void;
  onOverlayMa?: (period: number) => void;
};

const EXAMPLES = [
  "10일만에 10%이상 급등 20일전 거래량 분석해줘",
  "200일 이평선 돌파 30일 후 어떻게됐어?",
  "차트에 표시해줘",
];

export default function AssistantChat({ ticker, onApplied, onClearMarkers, onOverlayMa }: Props) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      text: "급등 전 거래량이나 이평선 돌파 이후를 물어보면 숫자로 계산해서 차트에 표시합니다. 예: 오라클 10일만에 10%이상 급등 20일전 거래량들 전부 분석해줘",
    },
  ]);
  const [lastMarkers, setLastMarkers] = useState<ChartMarker[]>([]);
  const [lastPayload, setLastPayload] = useState<AnalysisPayload | null>(null);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", text: message }]);
    setBusy(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, message }),
      });
      const data = (await res.json()) as {
        error?: string;
        reply?: string;
        action?: string;
        markers?: ChartMarker[];
        result?: AnalysisPayload["result"];
        series?: AnalysisPayload["series"];
        period?: number;
        overlayPeriods?: number[];
      };
      if (!res.ok || !data.reply) throw new Error(data.error ?? "비서가 응답하지 못했습니다.");

      setMessages((m) => [...m, { role: "assistant", text: data.reply! }]);

      if (data.action === "clear") {
        onClearMarkers?.();
        return;
      }
      if (data.action === "draw_ma" && data.period) {
        onOverlayMa?.(data.period);
        return;
      }
      if (data.action === "mark") {
        if (lastPayload) onApplied(lastPayload, lastMarkers);
        return;
      }
      if (data.action === "scan" && data.result && data.series) {
        const payload = { result: data.result, series: data.series };
        const markers = data.markers ?? [];
        setLastPayload(payload);
        setLastMarkers(markers);
        onApplied(payload, markers);
        for (const p of data.overlayPeriods ?? []) onOverlayMa?.(p);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">AI 비서</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        과거 급등·돌파를 계산해서 알려주고, 차트에 신호를 그립니다. 학습이 아니라 당신 데이터로 매번 다시 셉니다.
      </p>

      <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
        {messages.map((m, i) => (
          <p
            key={`${m.role}-${i}`}
            className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${
              m.role === "user" ? "bg-blue-500/15" : "bg-bg text-muted"
            }`}
          >
            {m.text}
          </p>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={busy}
            onClick={() => send(ex)}
            className="rounded-lg border border-border bg-bg px-2.5 py-1.5 text-left text-[11px] text-muted disabled:opacity-50"
          >
            {ex}
          </button>
        ))}
      </div>

      {error ? <p className="mt-2 text-sm text-down">{error}</p> : null}

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="예: 200일선 돌파 30일 후"
          className="min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-muted"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="shrink-0 rounded-xl bg-blue-500 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {busy ? "…" : "물어보기"}
        </button>
      </form>
    </section>
  );
}
