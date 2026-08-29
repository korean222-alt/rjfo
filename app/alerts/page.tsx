"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import TabNav from "@/components/TabNav";
import TickerInput from "@/components/TickerInput";
import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
import {
  DEFAULT_LONG_MA,
  DEFAULT_SHORT_MA,
  DEFAULT_TOUCH_MA,
  clampPeriod,
  orderedPair,
} from "@/lib/ma";
import { ALERT_SIGNALS, isMaSignal, labelForWatch, type SignalKey } from "@/lib/presets";

type Watch = {
  id: string;
  ticker: string;
  signal: SignalKey;
  createdAt: string;
  lastNotifiedDate?: string;
  params?: { short?: number; long?: number; period?: number };
};

type AlertsState = {
  watches: Watch[];
  storage: boolean;
  telegram: { botToken: boolean; chatId: boolean };
};

export default function AlertsPage() {
  const [state, setState] = useState<AlertsState | null>(null);
  const [ticker, setTicker] = useState("");
  const [signal, setSignal] = useState<SignalKey>(ALERT_SIGNALS[0].key);
  const [short, setShort] = useState(DEFAULT_SHORT_MA);
  const [long, setLong] = useState(DEFAULT_LONG_MA);
  const [period, setPeriod] = useState(DEFAULT_TOUCH_MA);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts", { cache: "no-store" });
      const data = (await res.json()) as AlertsState & { error?: string };
      setState(data);
      if (data.error) setError(data.error);
    } catch {
      setError("알림 설정을 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("ticker");
    const s = params.get("signal");
    const shortRaw = Number(params.get("short"));
    const longRaw = Number(params.get("long"));
    const periodRaw = Number(params.get("period"));
    if (t) setTicker(t.toUpperCase());
    if (s && ALERT_SIGNALS.some((sig) => sig.key === s)) setSignal(s as SignalKey);
    if (Number.isFinite(shortRaw) && Number.isFinite(longRaw)) {
      const pair = orderedPair(shortRaw, longRaw);
      setShort(pair.short);
      setLong(pair.long);
    }
    if (Number.isFinite(periodRaw) && periodRaw > 0) setPeriod(clampPeriod(periodRaw));
  }, []);

  const add = useCallback(async () => {
    setError(null);
    setNotice(null);
    const t = normalizeTicker(ticker);
    if (!t) return setError("티커를 입력해 주세요.");
    if (!isValidTicker(t)) return setError("올바른 티커 형식이 아닙니다.");
    const pair = orderedPair(short, long);
    const params = isMaSignal(signal)
      ? signal === "ma_touch"
        ? { period: clampPeriod(period) }
        : { short: pair.short, long: pair.long }
      : undefined;
    setBusy(true);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: t, signal, params }),
      });
      const data = (await res.json()) as AlertsState & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "등록에 실패했습니다.");
      setState(data);
      setTicker("");
      setNotice(`${t} · ${labelForWatch(signal, params)} 알림을 등록했습니다.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [signal, ticker, short, long, period]);

  const remove = useCallback(async (id: string) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/alerts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = (await res.json()) as AlertsState & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "삭제에 실패했습니다.");
      setState(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTest = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch("/api/alerts/test", { method: "POST" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "전송에 실패했습니다.");
      setNotice("테스트 메시지를 보냈습니다. 텔레그램을 확인해 주세요.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const telegramReady = Boolean(state?.telegram.botToken && state?.telegram.chatId);
  const ready = Boolean(state?.storage) && telegramReady;

  return (
    <main className="mx-auto max-w-lg px-4 py-8 pb-24">
      <TabNav />
      <Link href="/" className="text-sm text-muted">← 첫 화면</Link>
      <header className="mb-6 mt-4">
        <h1 className="text-2xl font-black">텔레그램 알림</h1>
        <p className="mt-1.5 text-sm text-muted leading-relaxed">등록한 종목(주식·비트코인)에 신호가 뜨는 날, 미국장 마감 뒤에 텔레그램으로 알려드립니다.</p>
      </header>

      {state && !ready ? (
        <section className="mb-6 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm leading-relaxed">
          <p className="font-semibold text-amber-300">아직 설정이 끝나지 않았습니다</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-amber-100/90">
            {!state.telegram.botToken ? <li>텔레그램에서 <span className="font-semibold">@BotFather</span>에게 <code>/newbot</code>을 보내 봇을 만들고, 받은 토큰을 Vercel 환경변수 <code className="text-amber-200">TELEGRAM_BOT_TOKEN</code>에 넣으세요.</li> : null}
            {!state.telegram.chatId ? <li>방금 만든 봇에게 아무 메시지나 한 번 보낸 뒤 <Link href="/api/alerts/chat-id" className="underline">이 주소</Link>를 열어 나온 id를 <code className="text-amber-200">TELEGRAM_CHAT_ID</code>에 넣으세요.</li> : null}
            {!state.storage ? <li>Vercel 프로젝트에 KV(Upstash Redis) 스토어를 연결하세요. 알림 목록을 저장할 곳입니다.</li> : null}
          </ol>
          <p className="mt-2 text-xs text-amber-100/70">환경변수를 바꾼 뒤에는 다시 배포해야 적용됩니다.</p>
        </section>
      ) : null}

      {telegramReady ? (
        <button type="button" onClick={sendTest} disabled={busy} className="mb-6 w-full rounded-xl border border-border bg-surface py-3 text-sm font-medium disabled:opacity-50">테스트 알림 보내기</button>
      ) : null}

      <section className="space-y-4 rounded-2xl border border-border bg-surface p-4">
        <p className="text-sm font-semibold">알림 추가</p>
        <TickerInput value={ticker} onChange={setTicker} />
        <div>
          <p className="mb-1.5 text-sm font-medium text-muted">어떤 신호를 받을까요?</p>
          <div className="flex flex-wrap gap-2">
            {ALERT_SIGNALS.map((s) => {
              const on = s.key === signal;
              return (
                <button key={s.key} type="button" onClick={() => setSignal(s.key)} aria-pressed={on} className={`rounded-full border px-3.5 py-2 text-sm transition active:scale-95 ${on ? "border-blue-400 bg-blue-500/15 text-white" : "border-border bg-bg text-muted"}`}>
                  {s.label}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted leading-relaxed">{ALERT_SIGNALS.find((s) => s.key === signal)?.hint}</p>
        </div>

        {signal === "golden_cross" || signal === "death_cross" ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-muted">단기선<input type="number" min={2} max={250} value={short} onChange={(e) => setShort(clampPeriod(Number(e.target.value)))} className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm tabular-nums" /></label>
            <label className="block text-xs text-muted">장기선<input type="number" min={2} max={250} value={long} onChange={(e) => setLong(clampPeriod(Number(e.target.value), DEFAULT_LONG_MA))} className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm tabular-nums" /></label>
          </div>
        ) : null}

        {signal === "ma_touch" ? (
          <label className="block text-xs text-muted">터치 이평 (일)<input type="number" min={2} max={250} value={period} onChange={(e) => setPeriod(clampPeriod(Number(e.target.value)))} className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm tabular-nums" /></label>
        ) : null}

        <button type="button" onClick={add} disabled={busy || !state?.storage} className="w-full rounded-xl bg-blue-500 py-3 text-sm font-bold text-white disabled:opacity-50">알림 등록</button>
      </section>

      {error ? <p className="mt-4 rounded-xl border border-down/40 bg-down/10 px-4 py-3 text-sm text-down">{error}</p> : null}
      {notice ? <p className="mt-4 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">{notice}</p> : null}

      <h2 className="mb-2 mt-8 text-sm font-semibold text-muted">등록된 알림 {state ? `(${state.watches.length})` : ""}</h2>
      {!state ? <p className="text-sm text-muted">불러오는 중…</p> : state.watches.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-4 py-6 text-center text-sm text-muted">아직 등록된 알림이 없습니다.</p>
      ) : (
        <ul className="space-y-2">
          {state.watches.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-semibold tracking-wide">{w.ticker}</p>
                <p className="mt-0.5 text-xs text-muted">{labelForWatch(w.signal, w.params)}{w.lastNotifiedDate ? ` · 마지막 알림 ${w.lastNotifiedDate}` : ""}</p>
              </div>
              <button type="button" onClick={() => remove(w.id)} disabled={busy} className="shrink-0 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-muted disabled:opacity-50">삭제</button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-8 text-center text-xs text-muted">과거 패턴이며 투자 판단의 근거가 아닙니다.</p>
    </main>
  );
}
