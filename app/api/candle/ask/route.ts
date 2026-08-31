/**
 * 캔들 리포트에 대한 후속 질문.
 *
 * /api/cycle/ask와 같은 구조다: 시세를 다시 받지도, 패턴을 다시 채점하지도 않고
 * 이미 계산된 FACTS만 받아서 질문에 답한다. 숫자는 FACTS 밖으로 나갈 수 없다.
 */

import { json } from "@/lib/json-response";
import { generateText, GeminiError } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_FACTS = 40_000;
const MAX_QUESTION = 300;

const SYSTEM = `너는 한국 주식·코인 차트 비서다. 사용자의 캔들 관련 질문에 답하는 게 유일한 임무다.

규칙:
- 주어진 FACTS의 숫자와 날짜만 사용한다. 없는 값은 지어내지 말고 "그 값은 화면에 없습니다"라고 말한다.
- 질문에 먼저 답한다. 요약을 다시 늘어놓지 마라.
- 2~5문장 한국어. 숫자를 인용할 때는 그 숫자가 무엇인지 같이 밝힌다.
- 적중률을 말할 때는 반드시 기저 적중률(아무 날이나 샀을 때)과 나란히 말한다. 그게 이 화면의 핵심이다.
- FACTS의 '등급'은 여섯 관문 중 몇 개를 통과했는지다. A는 여섯 개 전부다.
- '보정후q'는 패턴 수십 가지를 한꺼번에 검사한 걸 감안한 확률이다. 낮을수록 우연이 아니다.
- 매수·매도를 권하지 마라. "사도 되냐"고 물으면 근거의 강약과 표본의 한계를 말해 준다.
- 캔들 패턴은 과거 같은 모양 뒤의 평균일 뿐 예언이 아니라는 점을 필요할 때 짧게 덧붙인다.`;

export async function POST(req: Request) {
  let body: { question?: unknown; facts?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";
  const facts = typeof body.facts === "string" ? body.facts.slice(0, MAX_FACTS) : "";
  if (!question) return json({ error: "질문을 입력해 주세요." }, { status: 400 });
  if (!facts) return json({ error: "먼저 종목을 분석해 주세요." }, { status: 400 });

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return json(
      { error: "AI 답변이 꺼져 있습니다 (서버에 GEMINI_API_KEY가 없습니다). 아래 성적표의 숫자는 그대로 볼 수 있습니다." },
      { status: 503 },
    );
  }

  try {
    const { text, model } = await generateText({
      apiKey,
      system: SYSTEM,
      prompt: `질문: ${question}\n\nFACTS:\n${facts}\n\n이 FACTS만 가지고 질문에 답해라.`,
      json: false,
      maxOutputTokens: 600,
      deadlineMs: 12_000,
    });
    const answer = text.trim();
    if (!answer || answer.startsWith("{") || answer.startsWith("```")) {
      return json({ error: "AI가 답을 만들지 못했습니다. 질문을 조금 바꿔서 다시 물어봐 주세요." }, { status: 502 });
    }
    return json({ answer, model });
  } catch (e) {
    const msg = e instanceof GeminiError ? e.message : (e as Error).message;
    return json({ error: `AI 답변 실패: ${msg}` }, { status: 502 });
  }
}
