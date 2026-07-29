/**
 * 조건부 응답(ETag / If-None-Match → 304) 공용 헬퍼.
 *
 * 목적: 폴링 엔드포인트에서 데이터가 바뀌지 않았으면 304(빈 바디)만 반환해
 * Fast Origin Transfer(바이트 전송)를 절감한다. 폴링 주기는 그대로라 실시간성 손실 0.
 *
 * 동작: 응답에 payload 기반 ETag + `Cache-Control: private, no-cache`를 붙인다.
 * `no-cache`는 브라우저가 바디를 저장하되 매 요청 revalidate → 서버가 304를 주면
 * 브라우저가 캐시된 200 바디를 JS에 투명하게 돌려준다(클라이언트 코드 무변경).
 *
 * ETag는 **정확히 전송하는 바디 바이트**에 대한 SHA-256(Web Crypto) 강해시로 계산한다.
 * 비암호 32-bit 해시(FNV-1a+길이)는 서로 다른 payload가 실제로 충돌해(old If-None-Match +
 * 변경된 payload 가 304 빈바디로 오판) 변경 데이터가 유실될 수 있어 쓰지 않는다(삼순 P1).
 * 또한 바디를 **한 번만 직렬화**해 그 exact 문자열로 해시와 전송 바디를 일치시킨다
 * (직렬화-해시 드리프트로 인한 오판 차단).
 *
 * 순수 로직(computeStrongETag / ifNoneMatchSatisfied)은 Response와 분리해 테스트 가능하게 둔다.
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

/**
 * 직렬화된 바디 문자열로부터 SHA-256 기반 ETag를 계산한다(Web Crypto, edge-safe).
 * 바디 전체 SHA-256 을 opaque-tag 로 써 서로 다른 payload 의 충돌 확률을 암호학적으로
 * 무시 가능하게 만든다(FNV-1a 32-bit 충돌로 인한 변경 데이터 유실 차단). 길이 접두어는
 * 디버깅 힌트일 뿐 판정 근거가 아니다. 반환: `W/"<byteLen_hex>-<sha256_hex>"`.
 */
export async function computeStrongETag(body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `W/"${data.length.toString(16)}-${bufToHex(digest)}"`;
}

/**
 * If-None-Match 헤더가 주어진 ETag를 만족하는지 판정한다.
 * - `*`는 항상 매치(RFC 7232).
 * - 콤마로 나열된 여러 값 중 하나라도 매치하면 true.
 * - weak/strong 비교는 W/ 접두어를 제거한 opaque-tag 값끼리 비교(RFC 7232 §3.2 weak comparison).
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
 * 바디를 한 번만 직렬화(exact string)해 그 문자열로 ETag 해시와 전송 바디를 동일하게 쓴다.
 *
 * @param request 들어온 요청(If-None-Match 헤더 판독용)
 * @param payload 직렬화할 응답 데이터
 * @param init 추가 status/headers. Cache-Control 미지정 시 `private, no-cache` 기본.
 */
export async function jsonWithETag(
  request: Request,
  payload: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Promise<Response> {
  const status = init?.status ?? 200;
  // 바디를 한 번만 직렬화 → 그 exact 문자열로 ETag 해시와 전송 바디를 일치시킨다.
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const etag = await computeStrongETag(body);
  const ifNoneMatch = request.headers.get("if-none-match");

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
  return new Response(body, { status, headers });
}
