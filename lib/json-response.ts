import { NextResponse } from "next/server";

/**
 * NextResponse.json()과 동작은 같지만 Content-Type에 charset=utf-8을 명시한다.
 *
 * NextResponse.json()은 charset을 빼먹는다("content-type: application/json"만
 * 붙인다 — Fetch 표준 Response.json()이 원래 그렇다). fetch()로 소비할 때는
 * 문제없다(TextDecoder가 항상 UTF-8로 디코딩하니까). 하지만 사람이 API 주소를
 * 브라우저에 직접 열면(예: /api/alerts/chat-id, /api/diag) 일부 브라우저가
 * charset 없는 응답의 인코딩을 잘못 추측해 한글이 깨져 보인다 — 실제로
 * iOS Safari에서 관찰됨. 모든 API 라우트가 이 헬퍼로 응답한다.
 */
export function json<T>(body: T, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("content-type", "application/json; charset=utf-8");
  return res;
}
