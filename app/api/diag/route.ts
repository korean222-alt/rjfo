import { json } from "@/lib/json-response";
import { getProviders } from "@/lib/data";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { fundingInstrument, probeFundingSources } from "@/lib/data/funding";
import {
  generateText,
  GeminiError,
  geminiState,
  LATEST_ALIAS,
  PINNED_NEWEST,
  STATIC_CANDIDATES,
  summarizeAttempts,
} from "@/lib/gemini";
import { kvConfigured, kvSource } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 키가 실제로 어느 모델까지 닿는지 한 번 찔러본다 (`/api/diag?ai=1`).
 *
 * "AI가 안 뜬다"의 원인은 키 없음 / 한도 초과 / 그 모델이 이 키에 없음 / 너무 느림 중
 * 하나인데, 화면만 봐서는 구분이 안 된다. 짧은 프롬프트로 왕복 한 번을 재서 그대로 보여준다.
 */
async function probeAi(): Promise<Record<string, unknown>> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEY가 없습니다." };
  const started = Date.now();
  try {
    const { text, model, attempts } = await generateText({
      apiKey,
      system: "한국어로 짧게 답한다.",
      prompt: "연결 확인용이다. '연결됨'이라고만 답해라.",
      maxOutputTokens: 32,
      deadlineMs: 12_000,
    });
    return { ok: true, model, ms: Date.now() - started, reply: text.slice(0, 40), attempts };
  } catch (e) {
    const detail = e instanceof GeminiError ? summarizeAttempts(e.attempts) : "";
    return {
      ok: false,
      ms: Date.now() - started,
      error: (e as Error).message,
      attempts: detail,
    };
  }
}

/**
 * 진단용. `/api/diag?ticker=NVDA` 를 열면 각 시세 소스가 실제로 뭘 돌려줬는지 보여준다.
 *
 * "429가 뜬다"는 화면만 보고는 어느 소스가 왜 막혔는지 알 수 없다. 배포 환경에서
 * 원인을 추측하지 않으려고 둔다. 계산은 하지 않고 소스 상태만 확인한다.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const raw = params.get("ticker") ?? "AAPL";
  const ticker = normalizeTicker(raw);
  if (!isValidTicker(ticker)) {
    return json({ error: `'${ticker}'는 올바른 티커 형식이 아닙니다.` }, { status: 400 });
  }

  const providers = getProviders(ticker);
  const sources = [];
  for (const provider of providers) {
    const started = Date.now();
    try {
      const bars = await provider.getDailyBars(ticker, 5);
      const nonzero = bars.filter((b) => b.volume > 0).length;
      sources.push({
        source: provider.name,
        ok: true,
        ms: Date.now() - started,
        bars: bars.length,
        volumeDays: nonzero,
        first: bars[0]?.date ?? null,
        last: bars[bars.length - 1]?.date ?? null,
      });
    } catch (e) {
      sources.push({
        source: provider.name,
        ok: false,
        ms: Date.now() - started,
        status: e instanceof DataProviderError ? e.status : 500,
        error: (e as Error).message,
      });
    }
  }

  const primary = sources[0];

  // 코인이면 펀딩비 소스도 같이 본다. 펀딩 지표 3개가 화면에 안 뜨는 이유는
  // 거의 항상 여기 있는데, 화면만 봐서는 소스가 막힌 건지 원래 없는 건지 알 수 없다.
  const fundingSupported = fundingInstrument(ticker) != null;
  const funding = fundingSupported ? await probeFundingSources(ticker) : [];
  const fundingBest = funding.reduce<number>((m, f) => Math.max(m, f.days), 0);

  return json({
    ticker,
    // 실제로 어떤 순서로 시도하는지. 여기에 twelvedata가 없으면 키가 함수에 안 들어온 것이다.
    chain: providers.map((p) => p.name),
    // 어떤 환경변수가 실제로 함수에 들어와 있는지 (값은 노출하지 않는다)
    env: {
      DATA_PROVIDER: process.env.DATA_PROVIDER ?? null,
      DATA_DEADLINE_MS: process.env.DATA_DEADLINE_MS ?? null,
      hasKv: kvConfigured(),
      // 이름만. 어떤 접두사로 들어와 있는지 이게 없으면 알 수 없다.
      kvEnvNames: kvSource(),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      hasTwelveDataKey: Boolean(process.env.TWELVE_DATA_API_KEY),
    },
    // 어떤 모델로 답하고 있는지. 화면의 모델 이름이 이상할 때 여기서 체인을 확인한다.
    // (workingModel은 이 람다 인스턴스가 마지막으로 성공한 모델이라 null일 수 있다.)
    ai: {
      probe: params.get("ai") ? await probeAi() : "?ai=1 을 붙이면 실제로 한 번 호출해 봅니다.",
      pinned: PINNED_NEWEST,
      alias: LATEST_ALIAS,
      fallbacks: STATIC_CANDIDATES,
      // 이 인스턴스가 알아낸 것: 성공한 모델 / 없는 모델 / 굼뜬 모델 / 키에 열려 있는 목록.
      // "AI가 안 뜬다"의 원인이 어느 쪽인지 여기서 바로 갈린다.
      ...geminiState(),
    },
    sources,
    funding: {
      supported: fundingSupported,
      sources: funding,
      // 지표가 화면에 뜨려면 최소 이만큼은 있어야 한다(60일 z-점수 + 사이클 한 번).
      bestDays: fundingBest,
      hint: !fundingSupported
        ? "이 티커는 펀딩비 대상이 아닙니다 (주식이거나 목록에 없는 코인). 펀딩 지표 3개가 안 뜨는 게 정상입니다."
        : fundingBest === 0
          ? "펀딩비 소스가 전부 막혔습니다. 아래 error를 보세요 — 배포 서버 IP를 거래소가 차단하면(특히 미국 리전) 이렇게 됩니다."
          : fundingBest < 300
            ? `펀딩비가 ${fundingBest}일치뿐입니다. 사이클을 한 번도 못 덮으면 지표는 만들어져도 채점이 안 됩니다.`
            : `펀딩비 ${fundingBest}일치 확보. 펀딩 지표 3개가 성적표에 나와야 정상입니다.`,
    },
    hint: sources.every((s) => !s.ok)
      ? process.env.TWELVE_DATA_API_KEY
        ? "모든 소스 실패. 위 error를 보고 원인을 확인하세요."
        : "무료 소스가 서버 IP를 차단했습니다. twelvedata.com 무료 키를 TWELVE_DATA_API_KEY 환경변수에 넣으면 해결됩니다."
      : primary && !primary.ok
        ? `1순위 소스(${primary.source})가 실패해 폴백으로 넘어갔습니다. 위 ${primary.source}의 error가 진짜 원인입니다.`
        : "서버에서 시세 조회 가능.",
  });
}
