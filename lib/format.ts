/** 거래량 등 큰 수를 9.1M / 1.2B 형태로. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function pct(n: number | null, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function pctPoint(n: number | null, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%p`;
}

export function num(n: number | null, digits = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

/**
 * 모델 id를 사람이 읽는 이름으로. "gemini-3.8-flash" → "Gemini 3.8 Flash".
 *
 * 화면에 id를 그대로 박지 않는 이유: 폴백 체인 때문에 어떤 요청이 어떤 모델로
 * 처리됐는지가 매번 다르다. 무엇이 답했는지는 사용자가 알아야 하고, 별칭으로
 * 처리된 경우엔 "그때그때 다른 모델"이라는 사실까지 알아야 한다.
 */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "";
  const bare = id.replace(/^models\//, "");
  const alias = bare.endsWith("-latest");
  const pretty = (alias ? bare.slice(0, -"-latest".length) : bare)
    .split("-")
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
  return alias ? `${pretty} (최신 별칭)` : pretty;
}

/** 수익률 색상. */
export function returnColor(n: number | null): string {
  if (n == null || !isFinite(n)) return "text-muted";
  if (n > 0) return "text-up";
  if (n < 0) return "text-down";
  return "text-muted";
}
