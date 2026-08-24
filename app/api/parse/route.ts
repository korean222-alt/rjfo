import { NextResponse } from "next/server";
import { generateText, GeminiError, type GeminiTurn } from "@/lib/gemini";
import { FEW_SHOT, PARSER_SYSTEM_PROMPT } from "@/lib/parse-prompt";
import { extractJson, validateSpec } from "@/lib/validate-spec";
import type { FilterSpec } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXAMPLE_HINT =
  '예: "거래량 9천만주 이상 터진 날", "20일 평균 대비 3배 이상인데 주가는 거의 안 움직인 날", "세력이 매집한 것 같은 날"';

/** few-shot을 대화 형태로 넣는다. */
function fewShotHistory(): GeminiTurn[] {
  return FEW_SHOT.flatMap((ex) => [
    { role: "user" as const, text: `입력: "${ex.input}"` },
    { role: "model" as const, text: ex.output },
  ]);
}

export async function POST(req: Request) {
  // env는 호출 시점에 읽는다 (최상위에서 읽으면 빌드 타임에 인라인된다).
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다." },
      { status: 500 },
    );
  }

  let command: string;
  try {
    const body = (await req.json()) as { command?: unknown };
    command = typeof body.command === "string" ? body.command.trim() : "";
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  if (!command) {
    return NextResponse.json({ error: "명령을 입력해 주세요." }, { status: 400 });
  }
  if (command.length > 500) {
    return NextResponse.json({ error: "명령이 너무 깁니다 (500자 이내)." }, { status: 400 });
  }

  const fewShot = fewShotHistory();
  const userTurn = `입력: "${command}"`;
  let lastRaw = "";
  let lastDetail = "";

  // JSON 파싱 실패 시 1회 재시도 (모델 폴백 체인 자체는 lib/gemini.ts가 처리한다)
  for (let attempt = 0; attempt < 2; attempt++) {
    const retrying = attempt > 0;
    try {
      const { text, model } = await generateText({
        apiKey,
        system: PARSER_SYSTEM_PROMPT,
        history: retrying
          ? [...fewShot, { role: "user", text: userTurn }, { role: "model", text: lastRaw }]
          : fewShot,
        prompt: retrying
          ? "직전 출력이 유효한 JSON이 아니다. 설명이나 백틱 없이 JSON만 다시 출력해라."
          : userTurn,
        json: true,
        maxOutputTokens: 1024,
      });
      lastRaw = text.slice(0, 500);

      const spec: FilterSpec = validateSpec(extractJson(text));
      return NextResponse.json({ spec, model });
    } catch (e) {
      if (e instanceof GeminiError) {
        // 모델 호출 자체가 실패한 경우는 재시도해도 같다 (체인을 이미 다 돌았다).
        return NextResponse.json(
          { error: e.message, attempts: e.attempts },
          { status: e.status },
        );
      }
      lastDetail = (e as Error).message;
    }
  }

  return NextResponse.json(
    { error: `명령을 이해하지 못했어요. ${EXAMPLE_HINT}`, detail: lastDetail },
    { status: 422 },
  );
}
