/**
 * 캔들 리포트에 대한 후속 질문.
 *
 * /api/cycle/ask와 같은 구조다: 시세를 다시 받지도, 패턴을 다시 채점하지도 않고
 * 이미 계산된 FACTS만 받아서 질문에 답한다. 숫자는 FACTS 밖으로 나갈 수 없다.
 */

import { json } from "@/lib/json-response";
import { generateText, GeminiError, summarizeAttempts } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 요약·질문 모두 폴백 체인을 몇 번 돌 수 있어야 한다. 30초는 첫 모델이 굼뜨면
// 두 번째 후보에서 잘렸다.
export const maxDuration = 60;

const MAX_FACTS = 40_000;
const MAX_QUESTION = 300;

/** 화면이 뜰 때 자동으로 붙는 요약 (사이클 탭과 같은 구조 — 리포트를 막지 않는다). */
const SYSTEM_SUMMARY = `너는 한국 주식·코인 차트 비서다.
주어진 FACTS의 숫자와 날짜만 사용한다. 없는 값을 지어내지 마라.
5~8문장 한국어. 다음을 반드시 포함한다:
- 이 종목의 기저율(아무 날이나 샀을 때의 상승 확률·평균 수익)을 먼저 말한다
- 여섯 관문을 다 통과한 A등급 캔들 패턴이 있는지, 있다면 무엇이고 적중률이 기저보다 몇 %p 높은지
  (하나도 없으면 "근거가 데이터에 없다"고 분명히 말한다)
- 마지막 봉이 어떤 모양이고 지금 무슨 패턴이 떠 있는지
- 그 패턴의 과거 성적이 무엇이었는지 (평균 수익과 적중률을 기저와 나란히)
캔들 패턴의 효과는 원래 작다는 사실과, 이건 예언이 아니라 과거 같은 모양 뒤의 평균이라는 사실을
마지막에 한 문장으로 덧붙인다. 매수·매도를 권하지 마라.`;

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
  let body: { question?: unknown; facts?: unknown; mode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";
  const facts = typeof body.facts === "string" ? body.facts.slice(0, MAX_FACTS) : "";
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
      // 함수 상한(60초)보다 넉넉히 아래. 예전엔 15초라 굼뜬 모델 둘이면 끝이었다 —
      // 그게 "AI만 계속 안 뜨는" 화면의 실제 원인이었다.
      deadlineMs: summary ? 26_000 : 30_000,
      // 자동 요약은 사용자가 기다리지 않으니 한 모델에 오래 매달리지 않고 후보를 더 본다.
      ...(summary ? { attemptCapMs: 8_000 } : {}),
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
    console.warn(`[candle/ask] Gemini 실패 · facts ${facts.length}자 · ${msg} · ${detail}`);
    return json({ error: `AI 답변 실패: ${msg}${detail ? ` (${detail})` : ""}` }, { status: 502 });
  }
}
