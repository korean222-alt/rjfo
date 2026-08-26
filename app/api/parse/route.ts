import { json } from "@/lib/json-response";
import { generateText, GeminiError, type GeminiTurn } from "@/lib/gemini";
import { parseMaCommand } from "@/lib/ma";
import { FEW_SHOT, PARSER_SYSTEM_PROMPT } from "@/lib/parse-prompt";
import { extractJson, validateSpec } from "@/lib/validate-spec";
import { PRESET_CHIPS } from "@/lib/presets";
import type { FilterSpec } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXAMPLE_HINT = `예: ${PRESET_CHIPS.map((c) => `"${c.label}"`).join(", ")}`;

function fewShotHistory(): GeminiTurn[] {
  return FEW_SHOT.flatMap((ex) => [
    { role: "user" as const, text: `입력: "${ex.input}"` },
    { role: "model" as const, text: ex.output },
  ]);
}

export async function POST(req: Request) {
  let command: string;
  try {
    const body = (await req.json()) as { command?: unknown };
    command = typeof body.command === "string" ? body.command.trim() : "";
  } catch {
    return json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  if (!command) {
    return json({ error: "명령을 입력해 주세요." }, { status: 400 });
  }
  if (command.length > 500) {
    return json({ error: "명령이 너무 깁니다 (500자 이내)." }, { status: 400 });
  }

  const selected = PRESET_CHIPS.find((chip) => chip.command === command);
  if (selected) {
    const spec: FilterSpec = {
      conditions: selected.conditions,
      logic: "AND",
      preset: selected.preset,
      lookahead: selected.lookahead,
      interpretation: `${selected.label}: ${selected.hint}`,
      confidence: selected.lookahead ? "low" : "high",
    };
    return json({ spec, model: "preset" });
  }

  const maSpec = parseMaCommand(command);
  if (maSpec) {
    return json({ spec: maSpec, model: "ma" });
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return json(
      { error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다." },
      { status: 500 },
    );
  }

  const fewShot = fewShotHistory();
  const userTurn = `입력: "${command}"`;
  let lastRaw = "";
  let lastDetail = "";

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
      return json({ spec, model });
    } catch (e) {
      if (e instanceof GeminiError) {
        return json(
          { error: e.message, attempts: e.attempts },
          { status: e.status },
        );
      }
      lastDetail = (e as Error).message;
    }
  }

  return json(
    { error: `명령을 이해하지 못했어요. ${EXAMPLE_HINT}`, detail: lastDetail },
    { status: 422 },
  );
}
