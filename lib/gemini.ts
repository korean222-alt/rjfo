/**
 * Gemini 호출 레이어.
 *
 * 설계 이유:
 *  - 모델명을 하나만 박아 두면 구글이 조용히 폐기했을 때 404를 맞는다. 그래서 최신 핀 →
 *    최신 별칭(gemini-flash-latest) → 정적 후보 → 실제 사용 가능 모델 조회 순으로 폴백한다.
 *  - 전체 시도에 시간 예산을 둬서 Vercel 함수 타임아웃 전에 반드시 반환한다.
 *  - 실패하면 왜 실패했는지를 시도 로그로 남긴다. AI 문장이 안 나올 때 "그냥 안 됨"으로
 *    끝나면 원인을 화면에서도 로그에서도 알 수 없다 (summarizeAttempts).
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * 새로 나온 최신 모델. 맨 앞에 직접 박아 둔다.
 *
 * "버전을 박지 마라"는 이 파일의 원칙과 어긋나 보이지만, 위험한 건 버전을 박는 것 자체가
 * 아니라 *그것만* 쓰는 것이다. 체인의 맨 앞에 두면 폐기됐을 때 404 한 번을 먹고 바로
 * 아래 별칭으로 흘러내린다(그 뒤로는 이 인스턴스에서 다시 부르지 않는다). 대신 구글이
 * 별칭을 새 모델로 옮겨 붙이기 전까지의 공백에도 최신 모델을 쓸 수 있다.
 */
export const PINNED_NEWEST = "gemini-3.8-flash";

/** 구글이 계속 최신 flash로 가리켜주는 별칭. 핀이 죽으면 여기가 받는다. */
export const LATEST_ALIAS = "gemini-flash-latest";

/** 별칭까지 막혔을 때의 정적 후보 (최신 → 구형 순). */
export const STATIC_CANDIDATES = [
  "gemini-flash-lite-latest",
  "gemini-3.8-flash-lite",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
];

/**
 * Gemini 3.x는 기본으로 생각(thinking)을 하고, 3.8 Flash의 기본값은 medium이다.
 * 생각 토큰도 maxOutputTokens를 깎아 먹기 때문에 그대로 두면 두 가지가 터진다:
 *   - 응답이 느려져 아래 시간 예산(모델당 5.5초)을 넘긴다
 *   - 700토큰 예산을 생각이 다 써서 본문이 빈 채로 돌아온다
 * 이 앱이 모델에게 시키는 일은 "서버가 이미 계산해 놓은 숫자를 문장으로 옮기기"뿐이라
 * low로 충분하다. 채점·통계는 애초에 모델이 하지 않는다.
 */
const THINKING_LEVEL = "low";

/**
 * 생각을 켠 요청에만 얹어 주는 출력 예산.
 *
 * maxOutputTokens는 생각 토큰까지 합쳐서 센다. 라우트들이 잡아 둔 512~1024는 "문장"만
 * 생각하고 정한 값이라, low라도 생각이 몇백 토큰을 쓰면 본문이 잘리거나 아예 비어서
 * 돌아온다. 호출부를 건드리지 않고 여기서 여유분만 얹는다 (생각을 뺀 재시도에는 안 얹는다).
 */
const THINKING_TOKEN_RESERVE = 512;

/**
 * thinkingLevel을 받는 모델인가. 2.x 이하에 보내면 400이 난다.
 * 버전이 이름에 없는 별칭(gemini-flash-latest)은 지금 3.x를 가리키므로 보낸다 —
 * 틀렸으면 400을 받고 이 필드만 빼서 한 번 더 시도한다(아래 tryOne).
 */
export function supportsThinkingLevel(model: string): boolean {
  const m = /gemini-(\d+)/.exec(model.toLowerCase());
  if (!m) return true;
  return Number(m[1]) >= 3;
}

const DEFAULT_DEADLINE_MS = 15_000;

/**
 * 모델 하나에 줄 시간.
 *
 * 예전에는 5.5초 고정이었다. 그러면 프롬프트가 큰 요청(사이클 리포트 전체를 넘기는
 * 요약)에서 응답이 6초 걸리는 순간, 어떤 모델도 성공할 수 없다 — 후보를 아무리
 * 늘려도 전부 5.5초에서 잘려 나가고, 사용자에게는 "AI만 안 되는" 화면이 남는다.
 * 남은 예산에서 다음 후보용 여유만 떼고 나머지를 첫 모델에 몰아준다.
 */
const PER_ATTEMPT_MIN_MS = 5_500;
const PER_ATTEMPT_MAX_MS = 12_000;
const NEXT_MODEL_RESERVE_MS = 2_000;

export function attemptBudget(remainingMs: number): number {
  const wanted = Math.max(
    PER_ATTEMPT_MIN_MS,
    Math.min(PER_ATTEMPT_MAX_MS, remainingMs - NEXT_MODEL_RESERVE_MS),
  );
  return Math.min(remainingMs, wanted);
}

const NON_CHAT =
  /tts|embed|image|imagen|veo|lyria|audio|live|robotics|computer-use|native-audio/i;

export function isUsableChatModel(name: string): boolean {
  if (!name || !name.toLowerCase().includes("gemini")) return false;
  return !NON_CHAT.test(name);
}

function rankChatModel(name: string): number {
  const n = name.toLowerCase();
  if (n.includes("lite") && n.includes("latest")) return 0;
  if (n.includes("flash") && n.includes("latest")) return 1;
  if (n.includes("lite") && n.includes("flash")) return 2;
  if (n.includes("flash")) return 3;
  return 4;
}

/** 이름에 박힌 버전 (gemini-3.8-flash → 3.8). 같은 등급이면 높은 쪽을 먼저 쓴다. */
export function modelVersion(name: string): number {
  const m = /gemini-(\d+)(?:\.(\d+))?/.exec(name.toLowerCase());
  if (!m) return 0;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
}

// ── 람다 인스턴스 단위 상태 ────────────────────────────────────────
/** 마지막으로 성공한 모델. 다음 요청은 여기서 먼저 시도한다. */
let workingModel: string | null = null;
/** 404 등으로 폐기가 확인된 모델. 다시 시도하지 않는다. */
const deadModels = new Set<string>();
/** /models 조회 결과 캐시. */
let discoveredModels: string[] | null = null;

/** 테스트용 — 인스턴스 상태 초기화. */
export function __resetGeminiState(): void {
  workingModel = null;
  deadModels.clear();
  discoveredModels = null;
}

export function getWorkingModel(): string | null {
  return workingModel;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    readonly attempts: AttemptLog[] = [],
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export type AttemptLog = {
  model: string;
  outcome: "ok" | "rate_limited" | "gone" | "server_error" | "bad_request" | "timeout" | "network";
  status?: number;
  detail?: string;
};

/** 시도 결과를 사람 말로. 화면과 서버 로그에 같은 문장이 나가야 원인을 대조할 수 있다. */
const OUTCOME_LABEL: Record<AttemptLog["outcome"], string> = {
  ok: "성공",
  rate_limited: "사용량 한도",
  gone: "그런 모델 없음",
  server_error: "구글 서버 오류",
  bad_request: "요청 거절",
  timeout: "시간 초과",
  network: "네트워크 오류",
};

export function summarizeAttempts(attempts: AttemptLog[]): string {
  if (!attempts.length) return "시도 기록 없음";
  return attempts
    .map((a) => `${a.model} → ${OUTCOME_LABEL[a.outcome]}${a.status ? ` ${a.status}` : ""}`)
    .join(" · ");
}

export type GeminiTurn = { role: "user" | "model"; text: string };

export type GenerateOptions = {
  apiKey: string;
  system: string;
  /** few-shot 등 앞선 대화. 마지막 user 발화는 prompt로 따로 넘긴다. */
  history?: GeminiTurn[];
  prompt: string;
  maxOutputTokens?: number;
  /** JSON만 받고 싶을 때 (responseMimeType: application/json). */
  json?: boolean;
  /** 전체 시간 예산. 기본 AI_DEADLINE_MS 환경변수 → 15초. */
  deadlineMs?: number;
};

export type GenerateResult = {
  text: string;
  model: string;
  attempts: AttemptLog[];
};

/** 환경변수는 반드시 호출 시점에 읽는다 (최상위에서 읽으면 빌드 타임에 인라인된다). */
function deadlineFromEnv(): number {
  const raw = Number(process.env.AI_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEADLINE_MS;
}

/** 시도 순서: 마지막 성공 모델 → 최신 핀 → 최신 별칭 → 정적 후보. 폐기된 건 건너뛴다. */
function candidateOrder(): string[] {
  const ordered = [workingModel, PINNED_NEWEST, LATEST_ALIAS, ...STATIC_CANDIDATES];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of ordered) {
    if (!m || seen.has(m) || deadModels.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/** 이번 호출에 어떤 선택 필드를 실을지. 400을 받으면 하나씩 빼고 다시 시도한다. */
type CallMode = { json: boolean; thinking: boolean };

type CallOutcome =
  | { kind: "ok"; text: string; finishReason?: string }
  | { kind: "rate_limited"; status: number; detail: string }
  | { kind: "gone"; status: number; detail: string }
  | { kind: "server_error"; status: number; detail: string }
  | {
      kind: "bad_request";
      status: number;
      detail: string;
      mimeIssue: boolean;
      thinkingIssue: boolean;
    }
  | { kind: "timeout"; detail: string }
  | { kind: "network"; detail: string };

function buildBody(opts: GenerateOptions, mode: CallMode) {
  const contents = [
    ...(opts.history ?? []).map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: "user" as const, parts: [{ text: opts.prompt }] },
  ];

  const wanted = opts.maxOutputTokens ?? 1024;

  return {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents,
    generationConfig: {
      temperature: 0,
      maxOutputTokens: mode.thinking ? wanted + THINKING_TOKEN_RESERVE : wanted,
      ...(mode.json ? { responseMimeType: "application/json" } : {}),
      ...(mode.thinking ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL } } : {}),
    },
  };
}

function extractText(payload: unknown): { text: string; finishReason?: string } {
  const p = payload as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  const blocked = p.promptFeedback?.blockReason;
  if (blocked) throw new GeminiError(`요청이 차단되었습니다 (${blocked}).`, 422);

  const parts = p.candidates?.[0]?.content?.parts ?? [];
  return {
    text: parts.map((x) => x.text ?? "").join("").trim(),
    finishReason: p.candidates?.[0]?.finishReason,
  };
}

async function callModel(
  model: string,
  opts: GenerateOptions,
  mode: CallMode,
  timeoutMs: number,
): Promise<CallOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": opts.apiKey, // 키는 URL이 아니라 헤더로 (로그에 남지 않게)
      },
      body: JSON.stringify(buildBody(opts, mode)),
      signal: controller.signal,
      cache: "no-store",
    });

    if (res.ok) {
      const { text, finishReason } = extractText(await res.json());
      return { kind: "ok", text, finishReason };
    }

    const detail = (await res.text().catch(() => "")).slice(0, 400);

    // 429는 재시도하지 않는다. 같은 모델을 다시 두드려도 한도는 그대로다.
    if (res.status === 429) return { kind: "rate_limited", status: res.status, detail };
    // 404 = 폐기됐거나 이 키로 접근 불가한 모델.
    if (res.status === 404) return { kind: "gone", status: res.status, detail };
    if (res.status >= 500) return { kind: "server_error", status: res.status, detail };

    // 400인데 선택 필드 때문이면 그 필드만 빼고 한 번 더 해볼 가치가 있다.
    const mimeIssue = /response_?mime_?type|responseMimeType|response_schema/i.test(detail);
    const thinkingIssue = /thinking/i.test(detail);
    return { kind: "bad_request", status: res.status, detail, mimeIssue, thinkingIssue };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") return { kind: "timeout", detail: "시간 예산 초과" };
    if (err instanceof GeminiError) throw err;
    return { kind: "network", detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 정적 후보가 전부 막혔을 때, 이 키로 실제 쓸 수 있는 모델을 조회한다. */
async function discoverModels(apiKey: string, timeoutMs: number): Promise<string[]> {
  if (discoveredModels) return discoveredModels;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/models`, {
      headers: { "x-goog-api-key": apiKey },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return [];

    const body = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };

    const usable = (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(isUsableChatModel)
      // 등급(flash 우선) → 버전 높은 순. 등급을 먼저 보는 이유: pro는 느리고 비싸서
      // 아무리 최신이어도 이 앱의 시간 예산에 안 맞는다.
      .sort(
        (a, b) =>
          rankChatModel(a) - rankChatModel(b) ||
          modelVersion(b) - modelVersion(a) ||
          a.localeCompare(b),
      );

    discoveredModels = usable;
    return discoveredModels;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 폴백 체인을 따라 첫 성공을 반환한다.
 *  - 429 → 재시도 없이 바로 다음 모델
 *  - 5xx → 같은 모델 한 번만 재시도 (순간 장애)
 *  - 404 → 폐기 처리하고 다음 모델
 *  - 시간 예산 소진 → 즉시 중단
 */
export async function generateText(opts: GenerateOptions): Promise<GenerateResult> {
  const budget = opts.deadlineMs ?? deadlineFromEnv();
  const deadline = Date.now() + budget;
  const attempts: AttemptLog[] = [];
  const remaining = () => deadline - Date.now();

  async function tryOne(model: string): Promise<GenerateResult | null> {
    const mode: CallMode = { json: opts.json === true, thinking: supportsThinkingLevel(model) };
    // 재시도는 이유별로 딱 한 번씩만 허용한다. 라운드 수로 세면 이유가 겹칠 때
    // 같은 모델을 서너 번 두드리게 되고, 그만큼 다음 모델을 시도할 예산이 사라진다.
    let retriedServerError = false;
    let retriedNetwork = false;
    let strippedJson = false;
    let strippedThinking = false;

    for (;;) {
      const left = remaining();
      if (left <= 500) {
        attempts.push({ model, outcome: "timeout", detail: "예산 소진" });
        return null;
      }

      const out = await callModel(model, opts, mode, attemptBudget(left));

      if (out.kind === "ok") {
        if (!out.text) {
          // 3.x에서 생각 토큰이 출력 예산을 다 써버리면 본문 없이 MAX_TOKENS로 돌아온다.
          // 생각을 끄고 한 번만 더.
          if (mode.thinking && !strippedThinking) {
            strippedThinking = true;
            mode.thinking = false;
            attempts.push({
              model,
              outcome: "bad_request",
              detail: `빈 응답 (${out.finishReason ?? "이유 없음"}) — 생각 끄고 재시도`,
            });
            continue;
          }
          attempts.push({
            model,
            outcome: "bad_request",
            detail: `빈 응답 (${out.finishReason ?? "이유 없음"})`,
          });
          return null;
        }
        attempts.push({ model, outcome: "ok" });
        workingModel = model;
        return { text: out.text, model, attempts };
      }

      if (out.kind === "rate_limited") {
        attempts.push({ model, outcome: "rate_limited", status: out.status });
        return null; // 재시도 없이 다음 모델
      }

      if (out.kind === "gone") {
        attempts.push({ model, outcome: "gone", status: out.status });
        deadModels.add(model);
        if (workingModel === model) workingModel = null;
        return null;
      }

      if (out.kind === "server_error") {
        attempts.push({ model, outcome: "server_error", status: out.status });
        if (!retriedServerError) {
          retriedServerError = true; // 순간 장애만 같은 모델 한 번 더
          continue;
        }
        return null;
      }

      if (out.kind === "bad_request") {
        attempts.push({ model, outcome: "bad_request", status: out.status, detail: out.detail });
        // 옛 모델은 thinkingConfig를 모른다 → 그 필드만 빼고 한 번 더.
        if (out.thinkingIssue && mode.thinking && !strippedThinking) {
          strippedThinking = true;
          mode.thinking = false;
          continue;
        }
        if (out.mimeIssue && mode.json && !strippedJson) {
          strippedJson = true;
          mode.json = false; // JSON 강제만 빼고 한 번 더
          continue;
        }
        return null;
      }

      if (out.kind === "timeout") {
        attempts.push({ model, outcome: "timeout" });
        return null;
      }

      attempts.push({ model, outcome: "network", detail: out.detail });
      if (!retriedNetwork) {
        retriedNetwork = true;
        continue;
      }
      return null;
    }
  }

  // 1) 마지막 성공 모델 → 최신 별칭 → 정적 후보
  for (const model of candidateOrder()) {
    const hit = await tryOne(model);
    if (hit) return hit;
    if (remaining() <= 500) break;
  }

  // 2) 그래도 막히면 실제 쓸 수 있는 모델을 조회해서 시도
  if (remaining() > 1_000) {
    const tried = new Set(attempts.map((a) => a.model));
    const found = await discoverModels(opts.apiKey, Math.min(remaining(), 4_000));
    for (const model of found) {
      if (tried.has(model) || deadModels.has(model)) continue;
      const hit = await tryOne(model);
      if (hit) return hit;
      if (remaining() <= 500) break;
    }
  }

  const rateLimited = attempts.some((a) => a.outcome === "rate_limited");
  const timedOut = attempts.every((a) => a.outcome === "timeout");

  throw new GeminiError(
    rateLimited
      ? "Gemini 사용 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요."
      : timedOut
        ? "Gemini 응답이 너무 느립니다. 잠시 후 다시 시도해 주세요."
        : "사용 가능한 Gemini 모델을 찾지 못했습니다.",
    rateLimited ? 429 : 502,
    attempts,
  );
}
