import { json } from "@/lib/json-response";
import { getProviders } from "@/lib/data";
import { DataProviderError, isValidTicker, normalizeTicker } from "@/lib/data/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * 진단용. `/api/diag?ticker=NVDA` 를 열면 각 시세 소스가 실제로 뭘 돌려줬는지 보여준다.
 *
 * "429가 뜬다"는 화면만 보고는 어느 소스가 왜 막혔는지 알 수 없다. 배포 환경에서
 * 원인을 추측하지 않으려고 둔다. 계산은 하지 않고 소스 상태만 확인한다.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ticker") ?? "AAPL";
  const ticker = normalizeTicker(raw);
  if (!isValidTicker(ticker)) {
    return json({ error: `'${ticker}'는 올바른 티커 형식이 아닙니다.` }, { status: 400 });
  }

  const sources = [];
  for (const provider of getProviders()) {
    const started = Date.now();
    try {
      const bars = await provider.getDailyBars(ticker, 5);
      sources.push({
        source: provider.name,
        ok: true,
        ms: Date.now() - started,
        bars: bars.length,
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

  return json({
    ticker,
    // 어떤 환경변수가 실제로 함수에 들어와 있는지 (값은 노출하지 않는다)
    env: {
      DATA_PROVIDER: process.env.DATA_PROVIDER ?? null,
      DATA_DEADLINE_MS: process.env.DATA_DEADLINE_MS ?? null,
      hasKv: Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasTwelveDataKey: Boolean(process.env.TWELVE_DATA_API_KEY),
      // hasKv가 false인데 스토어는 연결돼 있다면, 통합이 이름을 다르게 지었을 수 있다.
      // 값은 절대 안 보여주고 길이만 잰다(0=비어있음, undefined=아예 없음).
      kvLikeEnvKeys: Object.fromEntries(
        Object.keys(process.env)
          .filter((k) => /^(KV_|REDIS_|UPSTASH_)/i.test(k))
          .map((k) => [k, process.env[k]?.length ?? 0]),
      ),
    },
    sources,
    hint: sources.every((s) => !s.ok)
      ? process.env.TWELVE_DATA_API_KEY
        ? "모든 소스 실패. 위 error를 보고 원인을 확인하세요."
        : "무료 소스가 서버 IP를 차단했습니다. twelvedata.com 무료 키를 TWELVE_DATA_API_KEY 환경변수에 넣으면 해결됩니다."
      : "서버에서 시세 조회 가능.",
  });
}
