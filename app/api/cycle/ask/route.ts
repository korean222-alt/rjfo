/**
 * 리포트에 대한 후속 질문.
 *
 * 예전에는 질문을 하면 /api/cycle을 통째로 다시 불렀다. 20년치 일봉을 다시 받고
 * 지표 30개를 다시 채점한 다음, 시스템 프롬프트가 "상승장 전환이 몇 번이었는지…"를
 * 반드시 포함하라고 시켜서, 무엇을 물어도 같은 요약이 다시 나왔다.
 * (사용자 입장에서는 "물어봤더니 검색을 해버리는" 동작이다.)
 *
 * 여기서는 이미 계산된 리포트의 FACTS만 받아서 질문에 답한다. 시세를 다시 받지 않고,
 * 계산도 다시 하지 않는다. 숫자는 여전히 FACTS 밖으로 나갈 수 없다.
 */

import { json } from "@/lib/json-response";
import { generateText, GeminiError, summarizeAttempts } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** FACTS는 지표 30여 개 요약이라 5KB 안팎이다. 넉넉히 잡되 무한정 받지는 않는다. */
const MAX_FACTS = 40_000;
const MAX_QUESTION = 300;

/**
 * 화면이 처음 뜰 때 자동으로 붙는 요약. 예전에는 /api/cycle이 이걸 기다렸다가 응답해서,
 * 모델이 굼뜬 날이면 리포트 전체가 20초씩 늦게 떴다. 이제 리포트는 바로 나가고
 * 이 요약만 뒤따라 붙는다 — 그래서 여기서는 "느리면 기다리지 말고 다음 모델"이 맞다.
 */
const SYSTEM_SUMMARY = `너는 한국 주식·코인 차트 비서다.
주어진 FACTS의 숫자와 날짜만 사용한다. 없는 값을 지어내지 마라.
5~8문장 한국어. 다음을 반드시 포함한다:
- 과거 상승장 전환이 몇 번이었고 언제였는지
- 매수 근거 여섯 관문을 다 통과한 A등급 신호가 있는지, 있다면 무엇이고 지금 켜져 있는지
  (하나도 없으면 "근거가 데이터에 없다"고 분명히 말한다)
- 그 신호가 바닥보다 빨랐는지 늦었는지
- 지금 무엇이 켜져 있고 과거 상승장 시작 때와 비교해 어느 정도인지
표본이 적다는 사실을 마지막에 한 문장으로 덧붙인다. 매수·매도를 권하지 마라.`;

const SYSTEM = `너는 한국 주식·코인 차트 비서다. 사용자의 질문에 답하는 게 유일한 임무다.

규칙:
- 주어진 FACTS의 숫자와 날짜만 사용한다. 없는 값은 지어내지 말고 "그 값은 화면에 없습니다"라고 말한다.
- 질문에 먼저 답한다. 요약을 다시 늘어놓지 마라.
- 2~5문장 한국어. 숫자를 인용할 때는 그 숫자가 무엇인지 같이 밝힌다.
- FACTS의 '등급'은 매수 근거 여섯 관문 중 몇 개를 통과했는지다. A는 여섯 개 전부다.
- '보정후q'는 지표를 수십 개 한꺼번에 검사한 걸 감안한 확률이다. 낮을수록 우연이 아니다.
- 매수·매도를 권하지 마라. "사도 되냐"고 물으면 근거의 강약과 표본의 한계를 말해 준다.
- 과거 표본이 사이클 몇 번뿐이라는 한계는 필요할 때만 짧게 덧붙인다.`;

export async function POST(req: Request) {
  let body: { question?: unknown; facts?: unknown; mode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";
  const facts = typeof body.facts === "string" ? body.facts.slice(0, MAX_FACTS) : "";
  // 자동 요약은 사용자가 기다리지 않는다(화면은 이미 떠 있다). 그래서 모델 하나를
  // 오래 붙잡지 않고 7초 안에 안 오면 다음 후보로 넘긴다.
  const summary = body.mode === "summary";
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
      system: summary ? SYSTEM_SUMMARY : SYSTEM,
      prompt: summary
        ? `사용자: ${question}\n\nFACTS:\n${facts}\n\n이 FACTS만 가지고 답해라.`
        : `질문: ${question}\n\nFACTS:\n${facts}\n\n이 FACTS만 가지고 질문에 답해라.`,
      json: false,
      maxOutputTokens: summary ? 700 : 600,
      // 사용자가 직접 누른 질문은 기다려 줄 가치가 있고, 자동 요약은 아니다.
      deadlineMs: summary ? 15_000 : 18_000,
      ...(summary ? { attemptCapMs: 7_000 } : {}),
    });
    const answer = text.trim();
    if (!answer || answer.startsWith("{") || answer.startsWith("```")) {
      return json({ error: "AI가 답을 만들지 못했습니다. 질문을 조금 바꿔서 다시 물어봐 주세요." }, { status: 502 });
    }
    return json({ answer, model });
  } catch (e) {
    // 어느 모델이 어떻게 실패했는지까지 돌려준다 — "실패했습니다"만으로는 손쓸 수가 없다.
    const detail = e instanceof GeminiError ? summarizeAttempts(e.attempts) : "";
    const msg = e instanceof GeminiError ? e.message : (e as Error).message;
    console.warn(`[cycle/ask] Gemini 실패 · facts ${facts.length}자 · ${msg} · ${detail}`);
    return json({ error: `AI 답변 실패: ${msg}${detail ? ` (${detail})` : ""}` }, { status: 502 });
  }
}
