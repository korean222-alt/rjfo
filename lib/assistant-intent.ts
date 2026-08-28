import { isValidTicker, normalizeTicker } from "@/lib/data/provider";
import { clampPeriod } from "@/lib/ma";

export type AssistantIntent =
  | {
      kind: "surge_prelude";
      ticker?: string;
      windowDays: number;
      minReturnPct: number;
      lookbackDays: number;
    }
  | {
      kind: "ma_breakout";
      ticker?: string;
      period: number;
      holdDays: number;
      direction: "up" | "down";
    }
  | { kind: "cycle"; ticker?: string }
  | { kind: "draw_ma"; ticker?: string; period: number }
  | { kind: "mark" }
  | { kind: "clear" }
  | { kind: "chat" };

const NAME_TO_TICKER: Record<string, string> = {
  오라클: "ORCL",
  엔비디아: "NVDA",
  테슬라: "TSLA",
  애플: "AAPL",
  마이크로소프트: "MSFT",
  아마존: "AMZN",
  구글: "GOOGL",
  메타: "META",
  비트코인: "BTC-USD",
  비트: "BTC-USD",
  이더리움: "ETH-USD",
  이더: "ETH-USD",
  솔라나: "SOL-USD",
};

const RESERVED = new Set(["MA", "SMA", "EMA", "ATR", "OBV", "USD", "USDT"]);

function pickTicker(text: string): string | undefined {
  for (const [name, ticker] of Object.entries(NAME_TO_TICKER)) {
    if (text.includes(name)) return ticker;
  }
  const m = text.match(/\b([A-Z]{1,5}(?:-USD)?)\b/);
  if (m) {
    const raw = m[1];
    if (RESERVED.has(raw) && !raw.endsWith("-USD")) return undefined;
    const t = normalizeTicker(raw);
    if (isValidTicker(t)) return t;
  }
  return undefined;
}

function numNear(text: string, re: RegExp, fallback: number): number {
  const m = text.match(re);
  if (!m) return fallback;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : fallback;
}

function pickPeriod(text: string, fallback: number): number {
  const ma = text.match(/ma\s*(\d+)/i);
  if (ma) return clampPeriod(Number(ma[1]), fallback);
  const day = text.match(/(\d+)\s*일/);
  if (day) return clampPeriod(Number(day[1]), fallback);
  return clampPeriod(fallback, fallback);
}

/** 한국어 명령을 스캐너 의도로. Gemini 없이 먼저 해석한다. */
export function parseAssistantIntent(message: string): AssistantIntent {
  const s = message.trim();
  if (!s) return { kind: "chat" };
  const ticker = pickTicker(s);

  if (/표시\s*끄|지워|마커\s*삭제|신호\s*지우/.test(s)) return { kind: "clear" };

  // 상승장/사이클 질문은 돌파·급등 검사보다 먼저 잡는다.
  // "365일선 돌파하면 상승장이 왔었어?"는 돌파 스캔이 아니라 사이클 분석이 답이다.
  if (/상승장|불장|강세장|대세\s*상승|사이클|하락장\s*(끝|종료|마무리)|바닥\s*(확인|잡)|추세\s*전환/.test(s)) {
    return { kind: "cycle", ticker };
  }

  const surge = s.match(/(\d+)\s*일(?:만)?에\s*(\d+(?:\.\d+)?)\s*%\s*이상\s*(?:급등|상승)/);
  const looseSurge = /급등|급상승|대상승/.test(s) && /거래량/.test(s);
  if (surge || looseSurge) {
    return {
      kind: "surge_prelude",
      ticker,
      windowDays: surge ? Number(surge[1]) : numNear(s, /(\d+)\s*일만/, 10),
      minReturnPct: surge ? Number(surge[2]) : numNear(s, /(\d+(?:\.\d+)?)\s*%/, 10),
      lookbackDays: numNear(s, /(\d+)\s*일\s*전/, 20),
    };
  }

  if (/돌파/.test(s) && /(\d+)\s*일|ma\s*\d+/i.test(s)) {
    return {
      kind: "ma_breakout",
      ticker,
      period: pickPeriod(s, 200),
      holdDays: numNear(s, /(\d+)\s*일\s*후/, 30),
      direction: /하향|아래|데드/.test(s) ? "down" : "up",
    };
  }

  if (
    /(?:이평|이동평균|일선|\bma\b)/i.test(s) &&
    /표시|그려|추가|넣어|올려/.test(s)
  ) {
    return { kind: "draw_ma", ticker, period: pickPeriod(s, 20) };
  }

  if (/표시해|그려줘|차트에|마커|신호\s*표시/.test(s) && !/급등|돌파|펀딩|이평|일선|\bma\b/i.test(s)) {
    return { kind: "mark" };
  }

  return { kind: "chat" };
}
