/**
 * Gemini 폴백 체인 검증 (실제 API 호출 없음 — fetch를 가짜로 갈아끼운다).
 *   npx tsx scripts/gemini-test.ts
 *
 * 검증 대상:
 *  - 최신 별칭(gemini-flash-latest)을 가장 먼저 시도하는가
 *  - 429는 재시도 없이 바로 다음 모델로 넘어가는가
 *  - 5xx만 같은 모델을 한 번 더 재시도하는가
 *  - 404는 폐기 처리하고 다시 시도하지 않는가
 *  - 정적 후보가 전부 막히면 /models 조회로 우회하는가
 *  - 마지막 성공 모델을 기억해서 다음 요청에 먼저 쓰는가
 *  - 시간 예산을 넘기지 않는가
 */
import {
  generateText,
  getWorkingModel,
  GeminiError,
  LATEST_ALIAS,
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

/** 모델별 응답을 흉내내는 가짜 fetch. */
function mockFetch(handler: Handler, listModels?: string[]) {
  calls = [];
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

    const r = handler(model, callIndex);
    const body =
      r.status === 200
        ? JSON.stringify(
            r.body ?? { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] },
          )
        : JSON.stringify({ error: { message: `status ${r.status}` } });

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
  deadlineMs: 5_000,
};

async function main() {
  console.log("\n[1] 최신 별칭을 가장 먼저 시도");
  {
    __resetGeminiState();
    mockFetch(() => ({ status: 200 }));
    const r = await generateText(baseOpts);
    assert(calls[0] === LATEST_ALIAS, `첫 호출이 ${LATEST_ALIAS}`);
    assert(r.model === LATEST_ALIAS, "성공 모델 = 최신 별칭");
    assert(calls.length === 1, "불필요한 추가 호출 없음");
  }

  console.log("\n[2] 429는 재시도 없이 다음 모델로");
  {
    __resetGeminiState();
    mockFetch((model) => (model === LATEST_ALIAS ? { status: 429 } : { status: 200 }));
    const r = await generateText(baseOpts);
    assert(
      calls.filter((c) => c === LATEST_ALIAS).length === 1,
      "429 모델은 정확히 1회만 호출 (재시도 없음)",
    );
    assert(r.model === "gemini-2.5-flash", `다음 후보로 넘어감 (${r.model})`);
  }

  console.log("\n[3] 5xx는 같은 모델 1회 재시도 후 다음 모델");
  {
    __resetGeminiState();
    mockFetch((model) => (model === LATEST_ALIAS ? { status: 503 } : { status: 200 }));
    const r = await generateText(baseOpts);
    assert(
      calls.filter((c) => c === LATEST_ALIAS).length === 2,
      "5xx 모델은 2회 호출 (1회 재시도)",
    );
    assert(r.model === "gemini-2.5-flash", "그래도 실패하면 다음 후보");
  }

  console.log("\n[4] 5xx가 재시도에서 성공하면 그대로 사용");
  {
    __resetGeminiState();
    mockFetch((model, i) =>
      model === LATEST_ALIAS && i === 0 ? { status: 503 } : { status: 200 },
    );
    const r = await generateText(baseOpts);
    assert(r.model === LATEST_ALIAS, "재시도 성공 시 별칭 유지");
    assert(calls.length === 2, "총 2회 호출");
  }

  console.log("\n[5] 404 모델은 폐기 처리되어 다음 요청에서 건너뜀");
  {
    __resetGeminiState();
    mockFetch((model) => (model === LATEST_ALIAS ? { status: 404 } : { status: 200 }));
    await generateText(baseOpts);
    const firstRunCalls = [...calls];
    assert(firstRunCalls[0] === LATEST_ALIAS, "1차: 별칭 시도");

    mockFetch((model) => (model === LATEST_ALIAS ? { status: 404 } : { status: 200 }));
    await generateText(baseOpts);
    assert(!calls.includes(LATEST_ALIAS), "2차: 폐기된 별칭을 다시 부르지 않음");
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
      (model) => (model === "gemini-3-flash-preview" ? { status: 200 } : { status: 404 }),
      ["gemini-3-flash-preview", "gemini-pro-something"],
    );
    const r = await generateText(baseOpts);
    assert(calls.includes("LIST"), "/models 조회를 실제로 수행");
    assert(r.model === "gemini-3-flash-preview", `조회된 모델로 성공 (${r.model})`);
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
