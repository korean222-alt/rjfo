import { NextResponse } from "next/server";
import { AlertStoreError, addWatch, alertsAvailable, listWatches, removeWatch } from "@/lib/alerts/store";
import { telegramStatus } from "@/lib/alerts/telegram";
import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
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
    return NextResponse.json({ error: e.message, ...status() }, { status: 400 });
  }
  return NextResponse.json(
    { error: `알림 처리 중 오류가 발생했습니다: ${(e as Error).message}`, ...status() },
    { status: 500 },
  );
}

export async function GET() {
  if (!alertsAvailable()) {
    // 저장소가 없다는 건 에러가 아니라 "아직 설정 전"이다. 화면이 안내를 띄울 수 있게 200으로 준다.
    return NextResponse.json({ watches: [], ...status() });
  }
  try {
    return NextResponse.json({ watches: await listWatches(), ...status() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  let body: { ticker?: unknown; signal?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const ticker = normalizeTicker(typeof body.ticker === "string" ? body.ticker : "");
  if (!ticker) return NextResponse.json({ error: "티커를 입력해 주세요." }, { status: 400 });
  if (!isValidTicker(ticker)) {
    return NextResponse.json({ error: `'${ticker}'는 올바른 티커 형식이 아닙니다.` }, { status: 400 });
  }

  const signalKey = typeof body.signal === "string" ? body.signal : "";
  const chip = findChip(signalKey);
  if (!chip) return NextResponse.json({ error: "신호를 선택해 주세요." }, { status: 400 });

  try {
    const watches = await addWatch(ticker, chip.key);
    return NextResponse.json({ watches, ...status() });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "삭제할 알림을 지정해 주세요." }, { status: 400 });
  try {
    const watches = await removeWatch(id);
    return NextResponse.json({ watches, ...status() });
  } catch (e) {
    return fail(e);
  }
}
