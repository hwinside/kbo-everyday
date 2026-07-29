/**
 * 조건부 응답(ETag / If-None-Match → 304) 공용 헬퍼.
 *
 * 목적: 폴링 엔드포인트에서 데이터가 바뀌지 않았으면 304(빈 바디)만 반환해
 * Fast Origin Transfer(바이트 전송)를 절감한다. 폴링 주기는 그대로라 실시간성 손실 0.
 *
 * 동작: 응답에 payload 기반 weak ETag + `Cache-Control: private, no-cache`를 붙인다.
 * `no-cache`는 브라우저가 바디를 저장하되 매 요청 revalidate → 서버가 304를 주면
 * 브라우저가 캐시된 200 바디를 JS에 투명하게 돌려준다(클라이언트 코드 무변경).
 *
 * 순수 로직(computeWeakETag / ifNoneMatchSatisfied)은 Response와 분리해 테스트 가능하게 둔다.
 */

/**
 * FNV-1a 32bit 해시(의존성/crypto 없이 edge-safe). 안정적이고 빠르다.
 * ETag는 무결성 서명이 아니라 변경 감지용이므로 비암호 해시로 충분하다.
 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619 (오버플로우 안전한 32bit 곱)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * payload로부터 weak ETag를 계산한다. 길이 접두어로 해시 충돌 여파를 낮춘다.
 * 반환 형식: `W/"<len>-<hash>"`.
 */
export function computeWeakETag(payload: unknown): string {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const hash = fnv1a(body);
  return `W/"${body.length.toString(16)}-${hash}"`;
}

/**
 * If-None-Match 헤더가 주어진 ETag를 만족하는지 판정한다.
 * - `*`는 항상 매치(RFC 7232).
 * - 콤마로 나열된 여러 값 중 하나라도 매치하면 true.
 * - weak/strong 비교는 W/ 접두어를 제거한 opaque-tag 값끼리 비교(weak comparison).
 */
export function ifNoneMatchSatisfied(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const norm = (t: string) => t.trim().replace(/^W\//, "");
  const target = norm(etag);
  if (!target) return false;
  const parts = ifNoneMatch.split(",");
  for (const p of parts) {
    const v = p.trim();
    if (v === "*") return true;
    if (norm(v) === target) return true;
  }
  return false;
}

const DEFAULT_CACHE_CONTROL = "private, no-cache";

/**
 * payload를 JSON 응답으로 만들되 ETag/304 조건부 처리를 적용한다.
 *
 * @param request 들어온 요청(If-None-Match 헤더 판독용)
 * @param payload 직렬화할 응답 데이터
 * @param init 추가 status/headers. Cache-Control 미지정 시 `private, no-cache` 기본.
 */
export function jsonWithETag(
  request: Request,
  payload: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const etag = computeWeakETag(payload);
  const ifNoneMatch = request.headers.get("if-none-match");
  const status = init?.status ?? 200;

  const headers = new Headers(init?.headers);
  headers.set("ETag", etag);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", DEFAULT_CACHE_CONTROL);

  // 조건부 304은 성공(2xx) 응답에 대해서만 의미가 있다.
  if (status === 200 && ifNoneMatch && ifNoneMatchSatisfied(ifNoneMatch, etag)) {
    const notModifiedHeaders = new Headers();
    notModifiedHeaders.set("ETag", etag);
    notModifiedHeaders.set("Cache-Control", headers.get("Cache-Control") ?? DEFAULT_CACHE_CONTROL);
    return new Response(null, { status: 304, headers: notModifiedHeaders });
  }

  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
}
