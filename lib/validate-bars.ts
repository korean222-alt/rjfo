import type { Bar } from "@/types";

export class BarValidationError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BARS = 20_000; // 5년 일봉이면 1300개 남짓. 페이로드 폭탄 방지용 상한.

/**
 * 브라우저가 직접 받아온 일봉을 서버가 받을 때 쓰는 검증기.
 *
 * 클라이언트가 보낸 값은 전부 의심한다. 형식이 조금이라도 어긋나면 통째로 거절한다.
 * (계산은 여전히 서버 코드가 한다 — 여기서 받는 건 '입력 데이터'뿐이다.)
 */
export function validateBars(raw: unknown): Bar[] {
  if (!Array.isArray(raw)) throw new BarValidationError("일봉 배열이 아닙니다.");
  if (raw.length > MAX_BARS) throw new BarValidationError("일봉이 너무 많습니다.");

  const bars: Bar[] = [];
  let prevDate = "";

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      throw new BarValidationError("일봉 항목이 객체가 아닙니다.");
    }
    const b = item as Record<string, unknown>;

    const date = b.date;
    if (typeof date !== "string" || !DATE_RE.test(date)) {
      throw new BarValidationError("날짜 형식이 올바르지 않습니다.");
    }
    // 오름차순·중복 없음. 지표 계산이 순서를 전제로 한다.
    if (date <= prevDate) {
      throw new BarValidationError("일봉 순서가 올바르지 않습니다.");
    }
    prevDate = date;

    const nums = ["open", "high", "low", "close", "volume"].map((k) => Number(b[k]));
    if (!nums.every((n) => Number.isFinite(n))) {
      throw new BarValidationError("숫자가 아닌 값이 있습니다.");
    }
    const [open, high, low, close, volume] = nums;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) {
      throw new BarValidationError("가격/거래량 값이 올바르지 않습니다.");
    }
    if (high < low) throw new BarValidationError("고가가 저가보다 낮습니다.");

    bars.push({ date, open, high, low, close, volume });
  }

  return bars;
}
