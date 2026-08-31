import { json } from "@/lib/json-response";
import { AlertStoreError, alertsAvailable } from "@/lib/alerts/store";
import {
  MAX_GRADE_TICKERS,
  addGradeWatch,
  listGradeWatches,
  removeGradeWatch,
} from "@/lib/alerts/grade-store";
import { telegramStatus } from "@/lib/alerts/telegram";
import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { FRESH_DAYS } from "@/lib/alerts/grade-alert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A등급 신호 알림 워치리스트 — 종목만 등록한다.
 * 무슨 신호를 볼지는 사람이 고르지 않고, 그 종목의 과거 사이클 채점 결과가 정한다.
 */
function status() {
  return {
    storage: alertsAvailable(),
    telegram: telegramStatus(),
    maxTickers: MAX_GRADE_TICKERS,
    freshDays: FRESH_DAYS,
  };
}

function fail(e: unknown) {
  if (e instanceof AlertStoreError) return json({ error: e.message, ...status() }, { status: 400 });
  return json(
    { error: `알림 처리 중 오류가 발생했습니다: ${(e as Error).message}`, ...status() },
    { status: 500 },
  );
}

export async function GET() {
  if (!alertsAvailable()) return json({ watches: [], ...status() });
  try {
    return json({ watches: await listGradeWatches(), ...status() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  let body: { ticker?: unknown };
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

  try {
    return json({ watches: await addGradeWatch(ticker), ...status() });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  const raw = new URL(req.url).searchParams.get("ticker");
  if (!raw) return json({ error: "삭제할 종목을 지정해 주세요." }, { status: 400 });
  try {
    return json({ watches: await removeGradeWatch(normalizeTicker(raw)), ...status() });
  } catch (e) {
    return fail(e);
  }
}
