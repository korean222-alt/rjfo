import { json } from "@/lib/json-response";
import { AlertStoreError, addWatch, alertsAvailable, listWatches, removeWatch } from "@/lib/alerts/store";
import { telegramStatus } from "@/lib/alerts/telegram";
import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
import type { MaParams } from "@/lib/ma";
import { ALERT_SIGNALS, findChip } from "@/lib/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function status() {
  return {
    storage: alertsAvailable(),
    telegram: telegramStatus(),
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
