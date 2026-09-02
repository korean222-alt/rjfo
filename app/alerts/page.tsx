"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import NavTabs from "@/components/NavTabs";
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
  storageSource?: { urlKey: string; tokenKey: string } | null;
  telegram: { botToken: boolean; chatId: boolean };
  deployment?: { env: string; branch: string | null };
  cronSecret?: boolean;
};

type GradeWatch = { ticker: string; createdAt: string; notified?: Record<string, string> };

type GradeState = {
  watches: GradeWatch[];
  storage: boolean;
  maxTickers: number;
  freshDays: number;
};

export default function AlertsPage() {
  const [state, setState] = useState<AlertsState | null>(null);
  const [grade, setGrade] = useState<GradeState | null>(null);
  const [gradeTicker, setGradeTicker] = useState("");
  const [gradeBusy, setGradeBusy] = useState(false);
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

  const loadGrade = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts/grade", { cache: "no-store" });
      setGrade((await res.json()) as GradeState);
    } catch {
      // A등급 섹션이 없어도 기존 알림은 쓸 수 있어야 하므로 조용히 넘어간다.
    }
  }, []);

  useEffect(() => { void load(); void loadGrade(); }, [load, loadGrade]);

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

  const addGrade = useCallback(async () => {
    setError(null);
    setNotice(null);
    const t = normalizeTicker(gradeTicker);
    if (!t) return setError("티커를 입력해 주세요.");
    if (!isValidTicker(t)) return setError("올바른 티커 형식이 아닙니다.");
    setGradeBusy(true);
    try {
      const res = await fetch("/api/alerts/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: t }),
      });
      const data = (await res.json()) as GradeState & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "등록에 실패했습니다.");
      setGrade(data);
      setGradeTicker("");
      setNotice(`${t}에 A등급 신호가 새로 켜지면 알려드립니다.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGradeBusy(false);
    }
  }, [gradeTicker]);

  const removeGrade = useCallback(async (ticker: string) => {
    setError(null);
    setNotice(null);
    setGradeBusy(true);
    try {
      const res = await fetch(`/api/alerts/grade?ticker=${encodeURIComponent(ticker)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as GradeState & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "삭제에 실패했습니다.");
      setGrade(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGradeBusy(false);
    }
  }, []);

  const checkGradeNow = useCallback(async (ticker: string) => {
    setError(null);
    setNotice(null);
    setGradeBusy(true);
    try {
      const res = await fetch("/api/alerts/grade/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const data = (await res.json()) as {
        sent?: number;
        notes?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "검사에 실패했습니다.");
      setNotice(
        data.sent
          ? `${ticker}: 신호 ${data.sent}개를 텔레그램으로 보냈습니다.`
          : `${ticker}: ${data.notes?.[0] ?? "지금 새로 켜진 A등급 신호가 없습니다."}`,
      );
      void loadGrade();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGradeBusy(false);
    }
  }, [loadGrade]);

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
  const isPreview = state?.deployment?.env === "preview";

  return (
    <main className="mx-auto max-w-lg px-4 py-6 pb-24">
      <NavTabs />
      <header className="mb-6">
        <h1 className="text-2xl font-black">텔레그램 알림</h1>
        <p className="mt-1.5 text-sm text-muted leading-relaxed">등록한 종목(주식·비트코인)에 신호가 뜨는 날, 미국장 마감 뒤에 텔레그램으로 알려드립니다.</p>
      </header>

      {state && !ready ? (
        <section className="mb-6 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm leading-relaxed">
          {/* 무엇이 되고 무엇이 안 되는지 먼저 보여준다. 텔레그램이 이미 붙어 있는데
              "아직 설정이 끝나지 않았습니다"만 뜨면, 테스트 알림을 받아 본 사람은
              무엇을 더 해야 하는지 알 수 없다. */}
          <p className="font-semibold text-amber-300">
            {telegramReady
              ? "텔레그램은 연결됐고, 알림 목록을 저장할 곳만 없습니다"
              : "아직 설정이 끝나지 않았습니다"}
          </p>
          <ul className="mt-2 space-y-1 text-amber-100/90">
            <li>{state.telegram.botToken ? "✅" : "❌"} 봇 토큰 (TELEGRAM_BOT_TOKEN)</li>
            <li>{state.telegram.chatId ? "✅" : "❌"} 채팅 ID (TELEGRAM_CHAT_ID)</li>
            <li>{state.storage ? "✅" : "❌"} 알림 목록 저장소 (KV / Upstash Redis)</li>
            <li>{state.cronSecret ? "✅" : "❌"} 크론 인증 (CRON_SECRET)</li>
          </ul>
          {/* Vercel 환경변수는 Production / Preview가 따로다. 여기가 Preview면
              "예전에 넣었는데 왜 또?"의 답이 대개 이것이다. */}
          {isPreview && (!state.telegram.botToken || !state.telegram.chatId) ? (
            <p className="mt-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
              지금 보고 있는 건 <b>Preview 배포</b>
              {state.deployment?.branch ? <> (브랜치 <code>{state.deployment.branch}</code>)</> : null}입니다.
              Vercel 환경변수는 <b>Production / Preview가 따로</b>라서, 전에 Production에만 넣었다면 여기서는 없는
              것으로 나옵니다 — 예전에 테스트 알림을 받은 것과 모순이 아닙니다. Vercel → Settings → Environment
              Variables에서 두 값의 체크박스에 <b>Preview</b>도 켜고 재배포하면 이 화면에서도 ✅가 됩니다.
              그리고 <b>크론(정기 알림)은 Production 배포에서만 돕니다</b> — 실제로 알림을 받으려면 이 코드가
              main에 머지돼 Production으로 올라가 있어야 합니다.
            </p>
          ) : null}
          {telegramReady ? (
            <p className="mt-2 text-xs text-amber-100/80">
              테스트 알림은 오는 게 맞습니다 — 그건 봇 토큰과 채팅 ID만 쓰기 때문입니다.
              저장소가 없으면 <b>등록한 알림 목록이 저장되지 않아</b> 신호가 떠도 보낼 대상이 없습니다.
            </p>
          ) : null}
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-amber-100/90">
            {!state.telegram.botToken ? <li>텔레그램에서 <span className="font-semibold">@BotFather</span>에게 <code>/newbot</code>을 보내 봇을 만들고, 받은 토큰을 Vercel 환경변수 <code className="text-amber-200">TELEGRAM_BOT_TOKEN</code>에 넣으세요.</li> : null}
            {!state.telegram.chatId ? <li>방금 만든 봇에게 아무 메시지나 한 번 보낸 뒤 <Link href="/api/alerts/chat-id" className="underline">이 주소</Link>를 열어 나온 id를 <code className="text-amber-200">TELEGRAM_CHAT_ID</code>에 넣으세요.</li> : null}
            {state.cronSecret === false ? <li><span className="font-semibold">CRON_SECRET이 없습니다.</span> 이게 없으면 알림 API 주소를 아는 사람이 크론을 직접 돌리고 텔레그램을 발송할 수 있어서, 운영 배포에서는 크론을 거절합니다 — 즉 <span className="font-semibold">알림이 오지 않습니다</span>. Vercel 프로젝트 Settings → Environment Variables에서 <code className="text-amber-200">CRON_SECRET</code>에 아무 긴 무작위 문자열을 넣고 Production에 저장한 뒤 재배포하세요. Vercel Cron이 그 값을 자동으로 붙여 줍니다.</li> : null}
            {!state.storage ? <li>Vercel 프로젝트에 KV(Upstash Redis) 스토어를 연결하세요. 이미 연결했다면 환경변수 이름이 <code className="text-amber-200">KV_REST_API_URL</code> / <code className="text-amber-200">KV_REST_API_TOKEN</code>(또는 <code>UPSTASH_REDIS_REST_URL</code> / <code>UPSTASH_REDIS_REST_TOKEN</code>)인지 확인하세요 — 스토어를 붙일 때 접두사를 넣으면 이름이 바뀝니다. <Link href="/api/diag" className="underline">진단 화면</Link>의 <code>kvEnvNames</code>가 실제로 인식된 이름입니다.</li> : null}
          </ol>
          <p className="mt-2 text-xs text-amber-100/70">환경변수를 바꾼 뒤에는 다시 배포해야 적용됩니다.</p>
        </section>
      ) : null}

      {state?.storage && state.storageSource ? (
        <p className="mb-6 text-xs text-muted">
          저장소 연결됨 · 환경변수 <code>{state.storageSource.urlKey}</code>
          {state.deployment ? <> · 배포 {state.deployment.env}{state.deployment.branch ? ` (${state.deployment.branch})` : ""}</> : null}
        </p>
      ) : null}

      {telegramReady ? (
        <button type="button" onClick={sendTest} disabled={busy} className="mb-6 w-full rounded-xl border border-border bg-surface py-3 text-sm font-medium disabled:opacity-50">테스트 알림 보내기</button>
      ) : null}

      {/* ── A등급(근거 있는 신호) 알림 ─────────────────────────────── */}
      <section className="mb-6 space-y-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-4">
        <div>
          <p className="text-sm font-semibold text-emerald-300">A등급 신호 알림 — 종목만 등록</p>
          <p className="mt-1.5 text-xs text-muted leading-relaxed">
            조건을 고르지 않습니다. 그 종목의 과거 상승장 전환으로 지표와 조합을 전부 채점해서,
            <b className="text-white"> 여섯 관문을 다 통과한 A등급 신호</b>가 새로 켜지는 날에만 알립니다.
            A등급이 하나도 없는 종목은 아무 알림도 오지 않습니다 — 그게 정상입니다
            {grade ? ` (신호가 뜬 뒤 ${grade.freshDays}거래일 안까지 '새로 켜진 것'으로 봅니다)` : ""}.
          </p>
        </div>
        <TickerInput value={gradeTicker} onChange={setGradeTicker} />
        <button
          type="button"
          onClick={addGrade}
          disabled={gradeBusy || !grade?.storage}
          className="w-full rounded-xl bg-emerald-500 py-3 text-sm font-bold text-white disabled:opacity-50"
        >
          A등급 알림 등록
        </button>

        {grade?.watches.length ? (
          <ul className="space-y-2">
            {grade.watches.map((w) => {
              const sentCount = Object.keys(w.notified ?? {}).length;
              return (
                <li key={w.ticker} className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold tracking-wide">{w.ticker}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      A등급 신호 감시 중{sentCount ? ` · 지금까지 ${sentCount}건 발송` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button type="button" onClick={() => checkGradeNow(w.ticker)} disabled={gradeBusy} className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted disabled:opacity-50">지금 검사</button>
                    <button type="button" onClick={() => removeGrade(w.ticker)} disabled={gradeBusy} className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted disabled:opacity-50">삭제</button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted">등록된 종목이 없습니다. 최대 {grade?.maxTickers ?? 5}개까지 등록할 수 있습니다.</p>
        )}
      </section>

      <section className="space-y-4 rounded-2xl border border-border bg-surface p-4">
        <p className="text-sm font-semibold">알림 추가</p>
        <p className="text-xs text-muted leading-relaxed">이쪽은 조건을 직접 고르는 알림입니다 (거래량 급증, 골든크로스 등).</p>
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
