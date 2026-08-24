import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { FEW_SHOT, PARSER_SYSTEM_PROMPT } from "@/lib/parse-prompt";
import { extractJson, SpecValidationError, validateSpec } from "@/lib/validate-spec";
import type { FilterSpec } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 파싱만 하므로 저렴한 모델로 충분하다. 계산은 절대 시키지 않는다.
// env는 호출 시점에 읽는다 (모듈 최상위에서 읽으면 빌드 타임에 인라인된다).
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const EXAMPLE_HINT =
  '예: "거래량 9천만주 이상 터진 날", "20일 평균 대비 3배 이상인데 주가는 거의 안 움직인 날", "세력이 매집한 것 같은 날"';

function buildMessages(command: string): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const ex of FEW_SHOT) {
    messages.push({ role: "user", content: `입력: "${ex.input}"` });
    messages.push({ role: "assistant", content: ex.output });
  }
  messages.push({ role: "user", content: `입력: "${command}"` });
  return messages;
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다." },
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

  const model = process.env.PARSE_MODEL || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });
  const messages = buildMessages(command);

  let lastError = "";
  // JSON 파싱 실패 시 1회 재시도
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        temperature: 0,
        system: PARSER_SYSTEM_PROMPT,
        messages:
          attempt === 0
            ? messages
            : [
                ...messages,
                {
                  role: "assistant",
                  content: "죄송합니다.",
                },
                {
                  role: "user",
                  content: "유효한 JSON만 다시 출력해라. 설명이나 백틱은 금지다.",
                },
              ],
      });

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const spec: FilterSpec = validateSpec(extractJson(text));
      return NextResponse.json({ spec });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        return NextResponse.json({ error: "API 키가 유효하지 않습니다." }, { status: 500 });
      }
      if (e instanceof Anthropic.RateLimitError) {
        return NextResponse.json(
          { error: "요청이 많습니다. 잠시 후 다시 시도해 주세요." },
          { status: 429 },
        );
      }
      if (e instanceof Anthropic.APIError && !(e instanceof SpecValidationError)) {
        lastError = `모델 호출 실패 (${e.status}).`;
        if (attempt === 1) {
          return NextResponse.json({ error: lastError }, { status: 502 });
        }
        continue;
      }
      lastError = (e as Error).message;
    }
  }

  return NextResponse.json(
    { error: `명령을 이해하지 못했어요. ${EXAMPLE_HINT}`, detail: lastError },
    { status: 422 },
  );
}
