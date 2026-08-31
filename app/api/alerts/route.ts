import { json } from "@/lib/json-response";
import { AlertStoreError, addWatch, alertsAvailable, listWatches, removeWatch } from "@/lib/alerts/store";
import { telegramStatus } from "@/lib/alerts/telegram";
import { kvSource } from "@/lib/kv";
import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
import type { MaParams } from "@/lib/ma";
import { ALERT_SIGNALS, findChip } from "@/lib/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function status() {
  return {
    storage: alertsAvailable(),
    // 어떤 환경변수 이름으로 붙었는지(값은 아니다). "저장소 없음"만 뜨면
    // 사용자는 이미 연결해 둔 스토어를 왜 못 보는지 확인할 방법이 없다.
    storageSource: kvSource(),
    telegram: telegramStatus(),
    /**
     * 어느 배포에서 보고 있는지.
     *
     * Vercel 환경변수는 Production / Preview / Development가 따로다. Production에만
     * 텔레그램 토큰을 넣어 두면 브랜치 미리보기(Preview)에서는 없는 것으로 나온다 —
     * "예전에 다 넣었는데 왜 또 설정하라고 하냐"의 진짜 원인이 이것이다.
     * 크론(Vercel Cron)도 Production 배포에서만 돈다.
     */
    deployment: {
      env: process.env.VERCEL_ENV ?? (process.env.VERCEL ? "unknown" : "local"),
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    },
    signals: ALERT_SIGNALS.map((c) => ({ key: c.key, label: c.label, hint: c.hint })),
  };
}

function fail(e: unknown) {
  if (e instanceof AlertStoreError) {
    return json({ error: e.message, ...status() }, { status: 400 });
  }
  return json(
    { error: `알림 처리 중 오류가 발생했습니다: ${(e as Error).message}`, ...status() },
    { status: 500 },
  );
}

function readParams(raw: unknown): MaParams | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const short = typeof o.short === "number" ? o.short : Number(o.short);
  const long = typeof o.long === "number" ? o.long : Number(o.long);
  const period = typeof o.period === "number" ? o.period : Number(o.period);
  return {
    short: Number.isFinite(short) ? short : undefined,
    long: Number.isFinite(long) ? long : undefined,
    period: Number.isFinite(period) ? period : undefined,
  };
}

export async function GET() {
  if (!alertsAvailable()) {
    return json({ watches: [], ...status() });
  }
  try {
    return json({ watches: await listWatches(), ...status() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  let body: { ticker?: unknown; signal?: unknown; params?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const ticker = normalizeTicker(typeof body.ticker === "string" ? body.ticker : "");
  if (!ticker) return json({ error: "티커를 입력해 주세요." }, { status: 400 });
  if (!isValidTicker(ticker)) {
    return json({ error: `'${ticker}'는 올바른 티커 형식이 아닙니다.` }, { status: 400 });
  }

  const signalKey = typeof body.signal === "string" ? body.signal : "";
  const chip = findChip(signalKey);
  if (!chip) return json({ error: "신호를 선택해 주세요." }, { status: 400 });

  try {
    const watches = await addWatch(ticker, chip.key, readParams(body.params));
    return json({ watches, ...status() });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return json({ error: "삭제할 알림을 지정해 주세요." }, { status: 400 });
  try {
    const watches = await removeWatch(id);
    return json({ watches, ...status() });
  } catch (e) {
    return fail(e);
  }
}
