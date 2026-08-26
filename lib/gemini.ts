/**
 * Gemini 호출 레이어.
 *
 * 설계 이유:
 *  - 모델명을 버전 고정하면 구글이 조용히 폐기했을 때 404를 맞는다.
 *    그래서 항상 최신을 가리키는 별칭(gemini-flash-latest)을 최우선으로 쓴다.
 *  - 그 별칭마저 막히는 경우를 대비해 정적 후보 → 실제 사용 가능 모델 조회 순으로 폴백한다.
 *  - 전체 시도에 시간 예산을 둬서 Vercel 함수 타임아웃 전에 반드시 반환한다.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/** 구글이 계속 최신 flash로 가리켜주는 별칭. 최우선. */
export const LATEST_ALIAS = "gemini-flash-latest";

/** 별칭이 막혔을 때의 정적 후보 (최신 → 구형 순). */
export const STATIC_CANDIDATES = [
  "gemini-flash-lite-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
];

const DEFAULT_DEADLINE_MS = 15_000;
const PER_ATTEMPT_CAP_MS = 5_500;

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

/** 시도 순서: 마지막 성공 모델 → 최신 별칭 → 정적 후보. 폐기된 건 건너뛴다. */
function candidateOrder(): string[] {
  const ordered = [workingModel, LATEST_ALIAS, ...STATIC_CANDIDATES];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of ordered) {
    if (!m || seen.has(m) || deadModels.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

type CallOutcome =
  | { kind: "ok"; text: string }
  | { kind: "rate_limited"; status: number; detail: string }
  | { kind: "gone"; status: number; detail: string }
  | { kind: "server_error"; status: number; detail: string }
  | { kind: "bad_request"; status: number; detail: string; mimeIssue: boolean }
  | { kind: "timeout"; detail: string }
  | { kind: "network"; detail: string };

function buildBody(opts: GenerateOptions, useJsonMime: boolean) {
  const contents = [
    ...(opts.history ?? []).map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: "user" as const, parts: [{ text: opts.prompt }] },
  ];

  return {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents,
    generationConfig: {
      temperature: 0,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
      ...(useJsonMime ? { responseMimeType: "application/json" } : {}),
    },
  };
}

function extractText(payload: unknown): string {
  const p = payload as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  const blocked = p.promptFeedback?.blockReason;
  if (blocked) throw new GeminiError(`요청이 차단되었습니다 (${blocked}).`, 422);

  const parts = p.candidates?.[0]?.content?.parts ?? [];
  return parts.map((x) => x.text ?? "").join("").trim();
}

async function callModel(
  model: string,
  opts: GenerateOptions,
  useJsonMime: boolean,
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
      body: JSON.stringify(buildBody(opts, useJsonMime)),
      signal: controller.signal,
      cache: "no-store",
    });

    if (res.ok) {
      return { kind: "ok", text: extractText(await res.json()) };
    }

    const detail = (await res.text().catch(() => "")).slice(0, 400);

    // 429는 재시도하지 않는다. 같은 모델을 다시 두드려도 한도는 그대로다.
    if (res.status === 429) return { kind: "rate_limited", status: res.status, detail };
    // 404 = 폐기됐거나 이 키로 접근 불가한 모델.
    if (res.status === 404) return { kind: "gone", status: res.status, detail };
    if (res.status >= 500) return { kind: "server_error", status: res.status, detail };

    // 400인데 응답 형식 때문이면 json mime 없이 한 번 더 해볼 가치가 있다.
    const mimeIssue = /response_?mime_?type|responseMimeType|response_schema/i.test(detail);
    return { kind: "bad_request", status: res.status, detail, mimeIssue };
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
      .sort((a, b) => rankChatModel(a) - rankChatModel(b) || a.localeCompare(b));

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
    let useJsonMime = opts.json === true;

    for (let round = 0; round < 2; round++) {
      const left = remaining();
      if (left <= 500) {
        attempts.push({ model, outcome: "timeout", detail: "예산 소진" });
        return null;
      }

      const out = await callModel(model, opts, useJsonMime, Math.min(left, PER_ATTEMPT_CAP_MS));

      if (out.kind === "ok") {
        if (!out.text) {
          attempts.push({ model, outcome: "bad_request", detail: "빈 응답" });
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
        if (round === 0) continue; // 순간 장애만 같은 모델 한 번 더
        return null;
      }

      if (out.kind === "bad_request") {
        attempts.push({ model, outcome: "bad_request", status: out.status, detail: out.detail });
        if (round === 0 && out.mimeIssue && useJsonMime) {
          useJsonMime = false; // JSON 강제만 빼고 한 번 더
          continue;
        }
        return null;
      }

      if (out.kind === "timeout") {
        attempts.push({ model, outcome: "timeout" });
        return null;
      }

      attempts.push({ model, outcome: "network", detail: out.detail });
      if (round === 0) continue;
      return null;
    }
    return null;
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
