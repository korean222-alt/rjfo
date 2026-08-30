/**
 * 시세 소스 체인 검증 (실제 네트워크 호출 없음 — fetch를 가짜로 갈아끼운다).
 *   npx tsx scripts/data-test.ts
 *
 * 검증 대상:
 *  - Yahoo 429일 때 다른 호스트 → 쿠키+crumb 세션 순으로 재시도하는가
 *  - Yahoo가 계속 429면 Stooq 폴백으로 넘어가는가
 *  - Stooq CSV 파싱 / 심볼 매핑이 맞는가
 *  - 404(없는 티커)는 재시도 없이 즉시 끝나는가
 *  - 전부 실패했을 때 만료된 캐시라도 내보내는가
 */
import { loadBars } from "../lib/data";
import { __clearMemoryCache, setCachedBars } from "../lib/data/cache";
import { DataProviderError } from "../lib/data/provider";
import { parseStooqCsv, toStooqSymbol } from "../lib/data/stooq";
import { fetchBarsInBrowser } from "../lib/client-quotes";
import { BarValidationError, validateBars } from "../lib/validate-bars";
import { parseTwelveValues, readTwelveResponse } from "../lib/data/twelvedata";
import { __resetYahooSession, applySplitsIfNeeded } from "../lib/data/yahoo";
import type { Bar } from "../types";

let failures = 0;

function assert(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

const realFetch = globalThis.fetch;
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let calls: string[] = [];

function install(handler: Handler) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
}

function restore() {
  globalThis.fetch = realFetch;
}

function reset() {
  __clearMemoryCache();
  __resetYahooSession();
  delete process.env.DATA_PROVIDER;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.TWELVE_DATA_API_KEY;
  process.env.DATA_DEADLINE_MS = "3000";
}

/** N일치 Yahoo chart 응답. */
function yahooChart(days = 90): Response {
  const start = Date.UTC(2024, 0, 2) / 1000;
  const timestamp: number[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  for (let i = 0; i < days; i++) {
    timestamp.push(start + i * 86400);
    const c = 100 + i * 0.1;
    open.push(c);
    high.push(c * 1.01);
    low.push(c * 0.99);
    close.push(c);
    volume.push(1_000_000);
  }
  return new Response(
    JSON.stringify({
      chart: {
        error: null,
        result: [
          {
            timestamp,
            indicators: { quote: [{ open, high, low, close, volume }] },
            meta: { exchangeTimezoneName: "America/New_York" },
          },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stooqCsv(days = 90): string {
  const rows = ["Date,Open,High,Low,Close,Volume"];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2024, 0, 2 + i)).toISOString().slice(0, 10);
    const c = (100 + i * 0.1).toFixed(2);
    rows.push(`${d},${c},${c},${c},${c},1000000`);
  }
  return rows.join("\n");
}


function okxCandles(days = 120): Response {
  const data: string[][] = [];
  const newest = Date.UTC(2024, 5, 1);
  for (let i = 0; i < days; i++) {
    const ts = newest - i * 86400000;
    const c = (60000 + i).toFixed(2);
    data.push([String(ts), c, c, c, c, "10", "1000", "250000000", "1"]);
  }
  return new Response(JSON.stringify({ code: "0", data }), { status: 200 });
}

function twelveZeroVolume(days = 90): Response {
  const values = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2024, 0, 2 + i)).toISOString().slice(0, 10);
    values.push({ datetime: d, open: "1", high: "1", low: "1", close: "1", volume: "0" });
  }
  return new Response(JSON.stringify({ status: "ok", values }), { status: 200 });
}

const main = async () => {

console.log("\n[1] Stooq 심볼 매핑");
{
  assert(toStooqSymbol("NVDA") === "nvda.us", "NVDA → nvda.us");
  assert(toStooqSymbol("BRK.B") === "brk-b.us", "BRK.B → brk-b.us (클래스는 하이픈)");
  assert(toStooqSymbol("005930.KS") === "005930.ks", "005930.KS → 005930.ks (거래소 접미사 유지)");
  assert(toStooqSymbol("^GSPC") === "^spx", "^GSPC → ^spx");
}

console.log("\n[2] Stooq CSV 파싱");
{
  const bars = parseStooqCsv(stooqCsv(5));
  assert(bars.length === 5, `5행 파싱 (${bars.length})`);
  assert(bars[0].date === "2024-01-02", `첫 날짜 ${bars[0].date}`);
  assert(bars[0].volume === 1_000_000, "거래량 파싱");
  assert(parseStooqCsv("<html>error</html>").length === 0, "CSV가 아니면 빈 배열");
  const dirty = "Date,Open,High,Low,Close,Volume\n2024-01-02,1,1,1,1,10\nbad,line\n2024-01-03,N/D,1,1,1,10";
  assert(parseStooqCsv(dirty).length === 1, "깨진 행은 버린다");
}

console.log("\n[3] Yahoo 429 → 호스트 교체 → 쿠키+crumb 재시도");
{
  reset();
  let chartHits = 0;
  install((url) => {
    if (url.includes("fc.yahoo.com")) {
      return new Response("", { status: 200, headers: { "set-cookie": "A1=abc; Path=/; Domain=.yahoo.com" } });
    }
    if (url.includes("/v1/test/getcrumb")) return new Response("Cr3mB", { status: 200 });
    chartHits++;
    // crumb을 달고 온 요청만 통과시킨다.
    return url.includes("crumb=") ? yahooChart() : new Response("Too Many Requests", { status: 429 });
  });

  const bars = await loadBars("NVDA");
  restore();
  assert(bars.length === 90, `일봉 ${bars.length}개 확보`);
  assert(chartHits >= 3, `crumb 없이 실패 후 재시도함 (chart 호출 ${chartHits}회)`);
  assert(calls.some((u) => u.includes("query2")), "두 번째 호스트도 시도함");
  assert(calls.some((u) => u.includes("crumb=Cr3mB")), "확보한 crumb을 붙여 재시도함");
}

console.log("\n[4] 캐시 히트면 외부 호출 없음");
{
  install(() => new Response("nope", { status: 500 }));
  const bars = await loadBars("NVDA"); // [3]에서 캐시됨
  restore();
  assert(bars.length === 90, "캐시에서 반환");
  assert(calls.length === 0, `외부 호출 0회 (${calls.length})`);
}

console.log("\n[5] Yahoo가 계속 429 → Stooq 폴백");
{
  reset();
  install((url) => {
    if (url.includes("stooq.com")) {
      return new Response(stooqCsv(120), { status: 200, headers: { "content-type": "text/csv" } });
    }
    return new Response("Too Many Requests", { status: 429 });
  });

  const bars = await loadBars("AAPL");
  restore();
  assert(bars.length === 120, `Stooq에서 ${bars.length}개 확보`);
  assert(calls.some((u) => u.includes("stooq.com/q/d/l/?s=aapl.us")), "stooq를 aapl.us로 조회");
}

console.log("\n[6] 없는 티커는 즉시 404");
{
  reset();
  install((url) => {
    if (url.includes("stooq.com")) return new Response("No data", { status: 200 });
    return new Response("Not Found", { status: 404 });
  });

  let err: unknown = null;
  try {
    await loadBars("ZZZZTEST");
  } catch (e) {
    err = e;
  }
  restore();
  assert(err instanceof DataProviderError && err.status === 404, "404 DataProviderError");
  const yahooCalls = calls.filter((u) => u.includes("finance.yahoo.com")).length;
  assert(yahooCalls === 1, `Yahoo는 재시도하지 않음 (${yahooCalls}회)`);
}

console.log("\n[7] 전부 실패해도 만료된 캐시가 있으면 그걸 쓴다");
{
  reset();
  const stale: Bar[] = parseStooqCsv(stooqCsv(70));
  await setCachedBars("MSFT", stale);
  // 저장 시각을 하루 전으로 되돌려 fresh(12시간)를 넘긴다.
  const { __setSavedAtForTest } = await import("../lib/data/cache");
  __setSavedAtForTest("MSFT", Date.now() - 24 * 60 * 60 * 1000);

  install(() => new Response("Too Many Requests", { status: 429 }));
  const bars = await loadBars("MSFT");
  restore();
  assert(bars.length === 70, `만료 캐시 반환 (${bars.length})`);
  assert(calls.length > 0, "만료됐으므로 외부 호출은 시도했다");
}

console.log("\n[8] 캐시도 없고 전부 429면 429 에러");
{
  reset();
  process.env.TWELVE_DATA_API_KEY = "test-key"; // 키가 있어도 전부 막힌 경우
  install(() => new Response("Too Many Requests", { status: 429 }));
  let err: unknown = null;
  try {
    await loadBars("TSLA");
  } catch (e) {
    err = e;
  }
  restore();
  assert(err instanceof DataProviderError && err.status === 429, "429 DataProviderError");
  assert(
    err instanceof DataProviderError && err.message.includes("잠시 후"),
    `사람이 읽을 수 있는 안내 문구: ${(err as Error).message}`,
  );
}

console.log("\n[9] Stooq가 CSV 대신 페이지를 주면 원인을 에러에 남긴다");
{
  reset();
  install((url) => {
    if (url.includes("stooq")) {
      return new Response("<html><body>Access denied</body></html>", { status: 200 });
    }
    return new Response("Too Many Requests", { status: 429 });
  });
  let err: unknown = null;
  try {
    await loadBars("GOOG");
  } catch (e) {
    err = e;
  }
  restore();
  const msg = (err as Error).message;
  assert(msg.includes("Access denied"), `응답 본문 일부가 에러에 담김: ${msg}`);
  assert(
    calls.filter((u) => u.includes("stooq")).length === 2,
    "stooq.com 실패 후 stooq.pl 미러도 시도",
  );
}

console.log("\n[10] 브라우저 직접 조회 (client-quotes)");
{
  reset();
  install((url, init) => {
    // CORS preflight를 만들지 않으려면 커스텀 헤더가 없어야 한다.
    assert(!init?.headers, "커스텀 헤더 없이 요청 (preflight 회피)");
    return url.includes("query1")
      ? new Response("blocked", { status: 429 })
      : yahooChart(300);
  });
  const bars = await fetchBarsInBrowser("NVDA");
  restore();
  assert(bars.length === 300, `브라우저 경로로 ${bars.length}개 확보`);
  assert(calls.some((u) => u.includes("query2")), "query1 실패 시 query2로 넘어감");
}

console.log("\n[11] 클라이언트가 보낸 일봉 검증 (validate-bars)");
{
  const good = [
    { date: "2024-01-02", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { date: "2024-01-03", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  ];
  assert(validateBars(good).length === 2, "정상 일봉 통과");

  const cases: Array<[string, unknown]> = [
    ["배열이 아님", { date: "2024-01-02" }],
    ["날짜 형식 오류", [{ ...good[0], date: "2024/01/02" }]],
    ["역순/중복", [good[1], good[0]]],
    ["숫자가 아님", [{ ...good[0], close: "많이" }]],
    ["음수 가격", [{ ...good[0], close: -1 }]],
    ["고가 < 저가", [{ ...good[0], high: 0.1, low: 5 }]],
  ];
  for (const [label, bad] of cases) {
    let threw = false;
    try {
      validateBars(bad);
    } catch (e) {
      threw = e instanceof BarValidationError;
    }
    assert(threw, `거절: ${label}`);
  }
}

function twelveJson(days = 90): Response {
  const values = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2024, 0, 2 + i)).toISOString().slice(0, 10);
    const c = (100 + i * 0.1).toFixed(2);
    // 문자열로 오는 게 정상이다 (Twelve Data는 숫자를 문자열로 준다).
    values.push({ datetime: d, open: c, high: c, low: c, close: c, volume: "1000000" });
  }
  return new Response(JSON.stringify({ status: "ok", values }), { status: 200 });
}

console.log("\n[12] Twelve Data — 키가 있으면 1순위");
{
  reset();
  process.env.TWELVE_DATA_API_KEY = "test-key";
  install((url) => {
    if (url.includes("api.twelvedata.com")) return twelveJson(300);
    return new Response("Too Many Requests", { status: 429 });
  });
  const bars = await loadBars("NVDA");
  restore();
  assert(bars.length === 300, `Twelve Data에서 ${bars.length}개 확보`);
  assert(calls.length === 1, `첫 소스에서 끝남 (호출 ${calls.length}회)`);
  assert(!calls[0].includes("finance.yahoo"), "Yahoo를 부르지 않음");
  assert(calls[0].includes("order=ASC"), "오래된 순으로 요청");
  assert(calls[0].includes("format=JSON"), "JSON 형식을 명시");
}

console.log("\n[13] Twelve Data — 값 파싱 / HTTP 200에 담긴 에러");
{
  const bars = parseTwelveValues([
    { datetime: "2024-01-03", open: "2", high: "3", low: "1", close: "2.5", volume: "5" },
    { datetime: "2024-01-02", open: "1", high: "2", low: "0.5", close: "1.5", volume: "10" },
    { datetime: "2024-01-02", open: "9", high: "9", low: "9", close: "9", volume: "9" }, // 중복
    { datetime: "bad", open: "1", high: "1", low: "1", close: "1", volume: "1" },
    { datetime: "2024-01-04", open: "1", high: "1", low: "1", close: "0", volume: "1" }, // 종가 0
  ]);
  assert(bars.length === 2, `유효한 2개만 남김 (${bars.length})`);
  assert(bars[0].date === "2024-01-02", "오래된 순 정렬");
  assert(bars[0].close === 1.5, "문자열 숫자를 number로 변환");

  // 한도 초과를 HTTP 200 본문에 담아 보내는 경우
  reset();
  process.env.TWELVE_DATA_API_KEY = "test-key";
  install((url) => {
    if (url.includes("api.twelvedata.com")) {
      return new Response(
        JSON.stringify({ code: 429, status: "error", message: "You have run out of API credits" }),
        { status: 200 },
      );
    }
    if (url.includes("stooq")) return new Response(stooqCsv(80), { status: 200 });
    return new Response("Too Many Requests", { status: 429 });
  });
  const fallback = await loadBars("AMD");
  restore();
  assert(fallback.length === 80, "한도 초과면 다음 소스로 넘어감");
}

console.log("\n[14] 키가 없고 전부 막히면 무엇을 해야 하는지 알려준다");
{
  reset();
  install(() => new Response("Too Many Requests", { status: 429 }));
  let err: unknown = null;
  try {
    await loadBars("META");
  } catch (e) {
    err = e;
  }
  restore();
  const msg = (err as Error).message;
  assert(msg.includes("TWELVE_DATA_API_KEY"), `조치 방법이 담긴 안내: ${msg}`);
}

console.log("\n[15] 1순위 소스의 실패 사유가 폴백 메시지에 가려지지 않는다");
{
  reset();
  process.env.TWELVE_DATA_API_KEY = "test-key";
  install((url) => {
    if (url.includes("api.twelvedata.com")) {
      return new Response(
        JSON.stringify({
          code: 403,
          status: "error",
          message: "/time_series is available exclusively with pro plan",
        }),
        { status: 200 },
      );
    }
    if (url.includes("stooq")) return new Response("Blocked by robots", { status: 200 });
    return new Response("Too Many Requests", { status: 429 });
  });
  let err: unknown = null;
  try {
    await loadBars("XYZ1");
  } catch (e) {
    err = e;
  }
  restore();
  const msg = (err as Error).message;
  assert(msg.includes("twelvedata"), `어느 소스가 실패했는지 남는다: ${msg}`);
  assert(msg.includes("plan"), "1순위 소스의 실제 사유(플랜 제한)가 살아 있다");
  assert(
    err instanceof DataProviderError && err.status !== 404,
    `폴백의 가짜 404로 덮이지 않는다 (status ${(err as DataProviderError).status})`,
  );
}

console.log("\n[16] Stooq의 차단 응답은 '티커 없음'이 아니다");
{
  reset();
  install((url) => {
    if (url.includes("stooq")) return new Response("Please enable JavaScript", { status: 200 });
    return new Response("Too Many Requests", { status: 429 });
  });
  let err: unknown = null;
  try {
    await loadBars("XYZ2");
  } catch (e) {
    err = e;
  }
  restore();
  assert(
    err instanceof DataProviderError && err.status !== 404,
    `차단 응답을 404로 분류하지 않는다 (status ${(err as DataProviderError).status})`,
  );
  assert((err as Error).message.includes("TWELVE_DATA_API_KEY"), "키가 없으면 조치 방법을 알려준다");
}

console.log("\n[17] 코인 거래량 0인 Twelve Data는 건너뛰고 거래소 시세를 쓴다");
{
  reset();
  process.env.TWELVE_DATA_API_KEY = "test-key";
  install((url) => {
    if (url.includes("okx.com")) return okxCandles(120);
    if (url.includes("api.twelvedata.com")) return twelveZeroVolume(90);
    return new Response("Too Many Requests", { status: 429 });
  });
  const bars = await loadBars("BTC-USD");
  restore();
  assert(bars.length >= 60, `코인 일봉 ${bars.length}개`);
  assert(bars.every((b) => b.volume > 0), "거래량이 0이 아니다");
  assert(calls.some((u) => u.includes("okx.com")), "OKX 공개 시세를 사용");
}

console.log("\n[18] 주식은 코인 거래소를 부르지 않는다");
{
  reset();
  process.env.TWELVE_DATA_API_KEY = "test-key";
  install((url) => {
    if (url.includes("okx.com")) return new Response("should not hit", { status: 500 });
    if (url.includes("api.twelvedata.com")) return twelveJson(80);
    return new Response("Too Many Requests", { status: 429 });
  });
  const bars = await loadBars("NVDA");
  restore();
  assert(bars.length === 80, `주식은 Twelve Data ${bars.length}개`);
  assert(!calls.some((u) => u.includes("okx.com")), "주식 조회는 OKX를 안 탄다");
}

console.log("\n[19] Twelve Data 본문 오류를 구분한다");
{
  let err: unknown = null;
  try {
    await readTwelveResponse(new Response("", { status: 200 }));
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof DataProviderError && /빈 응답/.test(err.message),
    `빈 본문: ${(err as Error).message}`,
  );

  err = null;
  try {
    await readTwelveResponse(new Response("<!DOCTYPE html><html>", { status: 200 }));
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof DataProviderError && /페이지/.test(err.message),
    `HTML: ${(err as Error).message}`,
  );

  err = null;
  try {
    await readTwelveResponse(new Response("{not json", { status: 200 }));
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof DataProviderError && /JSON이 아닙니다/.test(err.message),
    `잘린 JSON: ${(err as Error).message}`,
  );

  const ok = await readTwelveResponse(
    new Response(JSON.stringify({ status: "ok", values: [] }), { status: 200 }),
  );
  assert(ok.status === "ok", "정상 JSON은 파싱된다");
}

console.log("\n[20] Twelve Data HTTP 200 빈 본문이면 재시도");
{
  reset();
  process.env.TWELVE_DATA_API_KEY = "test-key";
  let hits = 0;
  install((url) => {
    if (url.includes("api.twelvedata.com")) {
      hits++;
      if (hits === 1) return new Response("", { status: 200 });
      return twelveJson(90);
    }
    return new Response("Too Many Requests", { status: 429 });
  });
  const bars = await loadBars("BE");
  restore();
  assert(bars.length === 90, `재시도로 ${bars.length}개 확보`);
  assert(hits === 2, `Twelve Data ${hits}회 호출`);
}

console.log("\n[21] Twelve Data 본문 타임아웃이면 재시도");
{
  reset();
  process.env.TWELVE_DATA_API_KEY = "test-key";
  let hits = 0;
  install((url) => {
    if (url.includes("api.twelvedata.com")) {
      hits++;
      if (hits === 1) {
        const res = new Response("partial", { status: 200 });
        Object.defineProperty(res, "text", {
          value: () => {
            const e = new Error("The operation was aborted due to timeout");
            e.name = "TimeoutError";
            return Promise.reject(e);
          },
        });
        return res;
      }
      return twelveJson(80);
    }
    return new Response("Too Many Requests", { status: 429 });
  });
  const bars = await loadBars("OKLO");
  restore();
  assert(bars.length === 80, `타임아웃 다음 재시도로 ${bars.length}개`);
  assert(hits === 2, `Twelve Data ${hits}회 호출`);
}

console.log("\n[22] 브라우저 Yahoo가 막히면 Stooq로 폴백");
{
  reset();
  install((url, init) => {
    assert(!init?.headers, "커스텀 헤더 없이 요청 (preflight 회피)");
    if (url.includes("finance.yahoo.com")) {
      throw new TypeError("Failed to fetch");
    }
    if (url.includes("stooq.com")) {
      return new Response(stooqCsv(200), { status: 200 });
    }
    return new Response("nope", { status: 500 });
  });
  const bars = await fetchBarsInBrowser("BE");
  restore();
  assert(bars.length === 200, `Stooq 브라우저 경로로 ${bars.length}개`);
  assert(calls.some((u) => u.includes("stooq.com/q/d/l/?s=be.us")), "be.us 로 조회");
}

console.log("\n[23] 분할 조정 — 정분할/병합, 이미 조정된 시계열은 건드리지 않는다");
{
  const dayBars = (closes: number[]): Bar[] => {
    const t0 = Date.parse("2024-01-01T00:00:00Z");
    return closes.map((c, i) => ({
      date: new Date(t0 + i * 86400000).toISOString().slice(0, 10),
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 1000,
    }));
  };
  const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;

  const fwdUnadj = applySplitsIfNeeded(
    dayBars([400, 400, 400, 400, 400, 100, 100, 100, 100, 100]),
    [{ date: at("2024-01-06"), numerator: 4, denominator: 1 }],
    "UTC",
  );
  assert(fwdUnadj[0].close === 100, `정분할 미조정 과거 종가 1/4 (실제 ${fwdUnadj[0].close})`);
  assert(fwdUnadj[0].volume === 4000, `정분할 미조정 과거 거래량 ×4 (실제 ${fwdUnadj[0].volume})`);
  assert(fwdUnadj[5].close === 100, "정분할 당일 종가는 그대로");

  const fwdAdj = applySplitsIfNeeded(
    dayBars([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
    [{ date: at("2024-01-06"), numerator: 4, denominator: 1 }],
    "UTC",
  );
  assert(fwdAdj[0].close === 100, `정분할 이미 조정이면 그대로 (실제 ${fwdAdj[0].close})`);

  const revUnadj = applySplitsIfNeeded(
    dayBars([10, 10, 10, 10, 10, 100, 100, 100, 100, 100]),
    [{ date: at("2024-01-06"), numerator: 1, denominator: 10 }],
    "UTC",
  );
  assert(revUnadj[0].close === 100, `병합 미조정 과거 종가 ×10 (실제 ${revUnadj[0].close})`);
  assert(revUnadj[0].volume === 100, `병합 미조정 과거 거래량 /10 (실제 ${revUnadj[0].volume})`);

  const revAdj = applySplitsIfNeeded(
    dayBars([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
    [{ date: at("2024-01-06"), numerator: 1, denominator: 10 }],
    "UTC",
  );
  assert(revAdj[0].close === 100, `병합 이미 조정이면 그대로 (실제 ${revAdj[0].close})`);
  assert(revAdj[0].volume === 1000, `병합 이미 조정이면 거래량 그대로 (실제 ${revAdj[0].volume})`);
}

console.log(failures === 0 ? "\n✅ 전부 통과\n" : `\n❌ ${failures}개 실패\n`);
process.exit(failures === 0 ? 0 : 1);

};

main();
