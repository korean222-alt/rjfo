/**
 * Gemini 폴백 체인 검증 (실제 API 호출 없음 — fetch를 가짜로 갈아끼운다).
 *   npx tsx scripts/gemini-test.ts
 *
 * 검증 대상:
 *  - 최신 핀(gemini-3.8-flash) → 최신 별칭(gemini-flash-latest) 순으로 시도하는가
 *  - 429는 재시도 없이 바로 다음 모델로 넘어가는가
 *  - 5xx만 같은 모델을 한 번 더 재시도하는가
 *  - 404는 폐기 처리하고 다시 시도하지 않는가
 *  - 정적 후보가 전부 막히면 /models 조회로 우회하는가
 *  - 마지막 성공 모델을 기억해서 다음 요청에 먼저 쓰는가
 *  - 3.x에는 thinkingLevel:low를 싣고, 구형 모델에는 싣지 않는가
 *  - thinking 때문에 400이 나거나 응답이 비면 그 필드만 빼고 재시도하는가
 *  - 시간 예산을 넘기지 않는가
 */
import {
  generateText,
  getWorkingModel,
  GeminiError,
  LATEST_ALIAS,
  PINNED_NEWEST,
  __resetGeminiState,
} from "../lib/gemini";

let failures = 0;

function assert(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

type Handler = (model: string, callIndex: number) => { status: number; body?: unknown };

const realFetch = globalThis.fetch;
let calls: string[] = [];
/** 모델별로 마지막에 보낸 요청 본문. thinkingConfig가 실렸는지 보려고 모은다. */
let bodies: { model: string; generationConfig?: Record<string, unknown> }[] = [];

function sentConfig(model: string): Record<string, unknown> | undefined {
  return bodies.filter((b) => b.model === model).pop()?.generationConfig;
}

/** 모델별 응답을 흉내내는 가짜 fetch. */
function mockFetch(handler: Handler, listModels?: string[]) {
  calls = [];
  bodies = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();

    if (href.endsWith("/models")) {
      calls.push("LIST");
      return new Response(
        JSON.stringify({
          models: (listModels ?? []).map((n) => ({
            name: `models/${n}`,
            supportedGenerationMethods: ["generateContent"],
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const model = decodeURIComponent(
      href.split("/models/")[1]?.split(":")[0] ?? "unknown",
    );
    const callIndex = calls.filter((c) => c === model).length;
    calls.push(model);
    try {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        generationConfig?: Record<string, unknown>;
      };
      bodies.push({ model, generationConfig: parsed.generationConfig });
    } catch {
      bodies.push({ model });
    }

    const r = handler(model, callIndex);
    const body = JSON.stringify(
      r.body ??
        (r.status === 200
          ? { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }
          : { error: { message: `status ${r.status}` } }),
    );

    return new Response(body, {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const baseOpts = {
  apiKey: "test-key",
  system: "system",
  prompt: "prompt",
  // 라우트들이 실제로 쓰는 값. 생각 여유분이 여기에 얹히는지 [10]에서 확인한다.
  maxOutputTokens: 700,
  deadlineMs: 5_000,
};

async function main() {
  console.log("\n[1] 최신 핀을 가장 먼저, 그 다음이 별칭");
  {
    __resetGeminiState();
    mockFetch(() => ({ status: 200 }));
    const r = await generateText(baseOpts);
    assert(calls[0] === PINNED_NEWEST, `첫 호출이 ${PINNED_NEWEST}`);
    assert(r.model === PINNED_NEWEST, "성공 모델 = 최신 핀");
    assert(calls.length === 1, "불필요한 추가 호출 없음");

    __resetGeminiState();
    mockFetch((model) => (model === PINNED_NEWEST ? { status: 404 } : { status: 200 }));
    const r2 = await generateText(baseOpts);
    assert(calls[1] === LATEST_ALIAS, `핀이 죽으면 두 번째가 ${LATEST_ALIAS}`);
    assert(r2.model === LATEST_ALIAS, "별칭으로 성공");
  }

  console.log("\n[2] 429는 재시도 없이 다음 모델로");
  {
    __resetGeminiState();
    mockFetch((model) => (model === PINNED_NEWEST ? { status: 429 } : { status: 200 }));
    const r = await generateText(baseOpts);
    assert(
      calls.filter((c) => c === PINNED_NEWEST).length === 1,
      "429 모델은 정확히 1회만 호출 (재시도 없음)",
    );
    assert(r.model === LATEST_ALIAS, `다음 후보로 넘어감 (${r.model})`);
  }

  console.log("\n[3] 5xx는 같은 모델 1회 재시도 후 다음 모델");
  {
    __resetGeminiState();
    mockFetch((model) => (model === PINNED_NEWEST ? { status: 503 } : { status: 200 }));
    const r = await generateText(baseOpts);
    assert(
      calls.filter((c) => c === PINNED_NEWEST).length === 2,
      "5xx 모델은 2회 호출 (1회 재시도)",
    );
    assert(r.model === LATEST_ALIAS, "그래도 실패하면 다음 후보");
  }

  console.log("\n[4] 5xx가 재시도에서 성공하면 그대로 사용");
  {
    __resetGeminiState();
    mockFetch((model, i) =>
      model === PINNED_NEWEST && i === 0 ? { status: 503 } : { status: 200 },
    );
    const r = await generateText(baseOpts);
    assert(r.model === PINNED_NEWEST, "재시도 성공 시 핀 유지");
    assert(calls.length === 2, "총 2회 호출");
  }

  console.log("\n[5] 404 모델은 폐기 처리되어 다음 요청에서 건너뜀");
  {
    __resetGeminiState();
    mockFetch((model) => (model === PINNED_NEWEST ? { status: 404 } : { status: 200 }));
    await generateText(baseOpts);
    assert(calls[0] === PINNED_NEWEST, "1차: 핀 시도");

    mockFetch((model) => (model === PINNED_NEWEST ? { status: 404 } : { status: 200 }));
    await generateText(baseOpts);
    assert(!calls.includes(PINNED_NEWEST), "2차: 폐기된 핀을 다시 부르지 않음");
  }

  console.log("\n[6] 마지막 성공 모델을 기억해서 먼저 시도");
  {
    __resetGeminiState();
    mockFetch((model) => (model === "gemini-2.0-flash" ? { status: 200 } : { status: 429 }));
    const r1 = await generateText(baseOpts);
    assert(r1.model === "gemini-2.0-flash", "1차 성공 모델 = gemini-2.0-flash");
    assert(getWorkingModel() === "gemini-2.0-flash", "workingModel 기억됨");

    mockFetch(() => ({ status: 200 }));
    await generateText(baseOpts);
    assert(calls[0] === "gemini-2.0-flash", "2차 첫 호출이 기억된 모델");
  }

  console.log("\n[7] 정적 후보가 전부 막히면 /models 조회로 우회");
  {
    __resetGeminiState();
    mockFetch(
      (model) => (model === "gemini-3-flash-discovered" ? { status: 200 } : { status: 404 }),
      ["gemini-3-flash-discovered", "gemini-pro-something"],
    );
    const r = await generateText(baseOpts);
    assert(calls.includes("LIST"), "/models 조회를 실제로 수행");
    assert(r.model === "gemini-3-flash-discovered", `조회된 모델로 성공 (${r.model})`);
  }

  console.log("\n[7b] 조회 결과는 같은 등급 안에서 최신 버전 우선");
  {
    __resetGeminiState();
    mockFetch(
      () => ({ status: 200 }),
      ["gemini-3.5-flash-x", "gemini-3.9-flash-x", "gemini-2.0-flash-x"],
    );
    // 정적 후보를 전부 404로 만들지 않으면 조회까지 안 간다 → 핸들러를 갈아끼운다.
    mockFetch(
      (model) => (model.endsWith("-x") ? { status: 200 } : { status: 404 }),
      ["gemini-3.5-flash-x", "gemini-3.9-flash-x", "gemini-2.0-flash-x"],
    );
    const r = await generateText(baseOpts);
    assert(r.model === "gemini-3.9-flash-x", `버전 높은 쪽 먼저 (${r.model})`);
  }

  console.log("\n[8b] /models 조회에서 TTS·이미지 모델은 건너뛴다");
  {
    __resetGeminiState();
    mockFetch(
      (model) => {
        if (model.includes("tts") || model.includes("image")) return { status: 400 };
        if (model === "gemini-3-pro-something") return { status: 200 };
        return { status: 404 };
      },
      ["gemini-2.5-flash-preview-tts", "gemini-2.5-flash-image", "gemini-3-pro-something"],
    );
    const r = await generateText(baseOpts);
    assert(calls.includes("LIST"), "TTS 필터 테스트도 /models 조회");
    assert(!calls.includes("gemini-2.5-flash-preview-tts"), "TTS 모델을 호출하지 않음");
    assert(!calls.includes("gemini-2.5-flash-image"), "이미지 모델을 호출하지 않음");
    assert(r.model === "gemini-3-pro-something", `텍스트 모델로 성공 (${r.model})`);
  }

  console.log("\n[8] 전부 실패하면 사람이 읽을 수 있는 에러");
  {
    __resetGeminiState();
    mockFetch(() => ({ status: 429 }), []);
    try {
      await generateText(baseOpts);
      assert(false, "에러가 던져져야 함");
    } catch (e) {
      const err = e as GeminiError;
      assert(err instanceof GeminiError, "GeminiError 타입");
      assert(err.status === 429, `429 상태 전달 (${err.status})`);
      assert(err.message.includes("한도"), `한도 초과 메시지: "${err.message}"`);
      assert(err.attempts.length > 0, `시도 로그 ${err.attempts.length}건 포함`);
    }
  }

  console.log("\n[10] 생각(thinking) 설정: 3.x에만 싣는다");
  {
    __resetGeminiState();
    mockFetch(() => ({ status: 200 }));
    await generateText(baseOpts);
    const cfg = sentConfig(PINNED_NEWEST) as {
      thinkingConfig?: { thinkingLevel?: string };
      maxOutputTokens?: number;
    };
    assert(cfg?.thinkingConfig?.thinkingLevel === "low", "핀(3.8)에 thinkingLevel:low 실림");

    assert(
      cfg?.maxOutputTokens === 700 + 512,
      `생각 켠 요청은 출력 예산에 여유분을 더함 (${cfg?.maxOutputTokens})`,
    );

    __resetGeminiState();
    mockFetch((model) => (model === "gemini-2.0-flash" ? { status: 200 } : { status: 404 }));
    const r = await generateText(baseOpts);
    assert(r.model === "gemini-2.0-flash", "구형 모델까지 내려감");
    assert(
      sentConfig("gemini-2.0-flash")?.thinkingConfig === undefined,
      "2.x에는 thinkingConfig를 싣지 않음",
    );
    assert(
      sentConfig("gemini-2.0-flash")?.maxOutputTokens === 700,
      "생각 없는 요청은 호출부가 정한 예산 그대로",
    );
  }

  console.log("\n[11] thinking 때문에 400이면 그 필드만 빼고 같은 모델 재시도");
  {
    __resetGeminiState();
    mockFetch((model, i) => {
      if (model !== PINNED_NEWEST) return { status: 404 };
      // 첫 호출(생각 실림)만 400, 두 번째(생각 뺀 것)는 성공.
      return i === 0
        ? { status: 400, body: { error: { message: "thinking_level is not supported" } } }
        : { status: 200 };
    });
    const r = await generateText(baseOpts);
    assert(r.model === PINNED_NEWEST, "같은 모델로 성공");
    assert(calls.filter((c) => c === PINNED_NEWEST).length === 2, "정확히 2회 호출");
    assert(sentConfig(PINNED_NEWEST)?.thinkingConfig === undefined, "재시도에는 생각 설정 없음");
  }

  console.log("\n[12] 생각이 출력 예산을 다 써서 본문이 비면 생각 끄고 재시도");
  {
    __resetGeminiState();
    mockFetch((model, i) => {
      if (model !== PINNED_NEWEST) return { status: 404 };
      return i === 0
        ? { status: 200, body: { candidates: [{ finishReason: "MAX_TOKENS", content: {} }] } }
        : { status: 200 };
    });
    const r = await generateText(baseOpts);
    assert(r.model === PINNED_NEWEST, "빈 응답 후 같은 모델로 성공");
    assert(sentConfig(PINNED_NEWEST)?.thinkingConfig === undefined, "재시도에는 생각 설정 없음");
  }

  console.log("\n[12b] 생각을 끄고도 계속 비면 다음 모델로 (무한 재시도 없음)");
  {
    __resetGeminiState();
    mockFetch((model) =>
      model === PINNED_NEWEST
        ? { status: 200, body: { candidates: [{ finishReason: "MAX_TOKENS", content: {} }] } }
        : { status: 200 },
    );
    const r = await generateText(baseOpts);
    assert(calls.filter((c) => c === PINNED_NEWEST).length === 2, "핀은 2회까지만");
    assert(r.model === LATEST_ALIAS, `다음 모델로 넘어감 (${r.model})`);
  }

  console.log("\n[9] 시간 예산을 넘기지 않음");
  {
    __resetGeminiState();
    // 모든 모델이 응답 없이 늘어지는 상황
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;

    const started = Date.now();
    try {
      await generateText({ ...baseOpts, deadlineMs: 1_200 });
      assert(false, "에러가 던져져야 함");
    } catch {
      const elapsed = Date.now() - started;
      assert(elapsed < 3_000, `예산 1.2초 → 실제 ${elapsed}ms 안에 반환`);
    }
  }

  globalThis.fetch = realFetch;
  console.log(failures === 0 ? "\n✅ 전부 통과\n" : `\n❌ ${failures}개 실패\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
