"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import CommandInput from "@/components/CommandInput";
import NavTabs from "@/components/NavTabs";
import TickerInput from "@/components/TickerInput";
import AssistantChat from "@/components/AssistantChat";
import { runAnalyze } from "@/lib/analyze-client";
import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { loadOverlayPeriods, loadSearchDraft, saveAnalysis, saveAiMarkers, saveOverlayPeriods, saveSearchDraft, clearAiMarkers } from "@/lib/session";
import type { FilterSpec } from "@/types";

export default function Home() {
  const router = useRouter();
  const [ticker, setTicker] = useState("");
  const [command, setCommand] = useState("");
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "parse" | "analyze" | "fallback">(null);

  useEffect(() => {
    const draft = loadSearchDraft();
    if (!draft) return;
    setTicker(draft.ticker);
    setCommand(draft.command);
  }, []);

  async function run() {
    setError(null);
    setTickerError(null);

    const t = normalizeTicker(ticker);
    if (!t) return setTickerError("티커를 입력해 주세요.");
    if (!isValidTicker(t)) return setTickerError("올바른 티커 형식이 아닙니다.");
    if (!command.trim()) return setError("무엇을 찾을지 입력해 주세요.");

    const nextCommand = command.trim();
    saveSearchDraft({ ticker: t, command: nextCommand });

    try {
      // 1) 자연어 → FilterSpec (Claude는 파싱만 한다)
      setBusy("parse");
      const parseRes = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: nextCommand }),
      });
      const parsed = (await parseRes.json()) as { spec?: FilterSpec; error?: string };
      if (!parseRes.ok || !parsed.spec) {
        throw new Error(parsed.error ?? "명령을 이해하지 못했어요.");
      }

      // 2) 데이터 로드 + 지표 + 필터 + 통계 (전부 서버의 TypeScript 코드가 계산)
      //    서버가 시세 소스에 막히면 브라우저가 직접 받아 넘기는 경로로 폴백한다.
      setBusy("analyze");
      const payload = await runAnalyze(t, parsed.spec, {
        onFallback: () => setBusy("fallback"),
      });

      saveAnalysis(payload);
      clearAiMarkers();
      router.push("/results");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-6 pb-24">
      <NavTabs />
      <header className="mb-7">
        <h1 className="text-2xl font-black">거래량 분석기</h1>
        <p className="mt-1.5 text-sm text-muted leading-relaxed">
          조건에 걸린 날의 이후 성과를, 아무 날이나 골랐을 때의 성과와 나란히 비교합니다.
        </p>
      </header>

      <div className="space-y-6">
        <TickerInput
          value={ticker}
          onChange={(next) => {
            setTicker(next);
            saveSearchDraft({ ticker: next, command });
          }}
          error={tickerError}
        />
        <CommandInput
          value={command}
          onChange={(next) => {
            setCommand(next);
            saveSearchDraft({ ticker, command: next });
          }}
        />

        {error ? (
          <p className="rounded-xl border border-down/40 bg-down/10 px-4 py-3 text-sm text-down">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={run}
          disabled={busy !== null}
          className="w-full rounded-xl bg-blue-500 py-4 text-base font-bold text-white
                     disabled:opacity-50 active:scale-[0.99] transition"
        >
          {busy === "parse"
            ? "명령 해석 중…"
            : busy === "analyze"
              ? "과거 데이터 분석 중…"
              : busy === "fallback"
                ? "시세 직접 받아오는 중…"
                : "분석하기"}
        </button>
      </div>

      <div className="mt-8">
        <AssistantChat
          ticker={ticker}
          onApplied={(payload, markers) => {
            saveAnalysis(payload);
            saveAiMarkers(markers);
            saveSearchDraft({ ticker: payload.result.ticker, command: payload.result.spec.interpretation });
            router.push("/results");
          }}
          onOverlayMa={(period) => {
            const cur = loadOverlayPeriods();
            if (!cur.includes(period)) saveOverlayPeriods([...cur, period]);
          }}
        />
      </div>

      <p className="mt-8 text-center text-xs text-muted">
        과거 패턴이며 투자 판단의 근거가 아닙니다.
      </p>
    </main>
  );
}
