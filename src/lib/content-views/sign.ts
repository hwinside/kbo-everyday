import { createHmac, timingSafeEqual } from "node:crypto";
import { contentViewKey, newsContentId, type ContentViewType } from "./policy";

/**
 * 콘텐츠 조회수 서명 키 (서버 전용) — 2026-08-14 삼순 blocker3.
 *
 * 공개 /api/content-views/view 가 임의 content_id 를 service_role 로 upsert 하면
 * id 만 바꿔 rate-limit 을 우회하며 무한 행 생성·수치 오염이 가능하다. 그래서
 * 콘텐츠 목록을 실제로 서빙하는 서버 route(/api/news·/api/shorts-feed·/api/team-videos)가
 * 항목마다 HMAC 서명(viewToken)을 발급하고, /view 는 유효한 서명이 있는 키만 증가시킨다.
 * → 집계 가능한 content_id 집합 = 서버가 실제로 목록에 내보낸 콘텐츠로 한정.
 *
 * 비밀키는 서버 전용 env(SUPABASE_SERVICE_ROLE_KEY)에서 유도 — 새 env 없이
 * 클라이언트에 절대 노출되지 않는 값을 재사용한다(서명 용도로만 파생).
 */

const TOKEN_BYTES = 16; // hex 32자 — 위조 방지 목적엔 충분, payload 경량 유지

function signingSecret(): string | null {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) return null;
  return `content-view-v1:${base}`;
}

/** 서버 전용: content key 서명 발급. env 부재(로컬 등) 시 null → 클라는 전송 스킵. */
export function signContentView(type: ContentViewType, id: string): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(contentViewKey(type, id))
    .digest("hex")
    .slice(0, TOKEN_BYTES * 2);
}

/**
 * 뉴스 목록 응답 공통 종단 — 항목별 viewToken 부착.
 * cold/cache-hit/batch 모든 응답 경로가 이 함수 하나를 통과해야 한다(삼순 2차 리뷰 —
 * 캐시-hit 경로가 unsigned raw를 반환해 첫 요청 이후 전부 미집계되던 결손 방지).
 * 서명은 결정론이라 캐시된 항목에 다시 불러도 같은 토큰이 나온다.
 */
export function withNewsViewTokens<T extends { link: string; originalLink?: string }>(
  items: T[],
): (T & { viewToken?: string })[] {
  return items.map((item) => {
    const contentId = newsContentId(item.link, item.originalLink);
    const viewToken = contentId ? signContentView("news", contentId) : null;
    return viewToken ? { ...item, viewToken } : item;
  });
}

/** 서버 전용: 서명 검증 (timing-safe). */
export function verifyContentViewToken(
  type: ContentViewType,
  id: string,
  token: unknown,
): boolean {
  if (typeof token !== "string" || token.length !== TOKEN_BYTES * 2) return false;
  const expected = signContentView(type, id);
  if (!expected) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(token, "utf8"));
  } catch {
    return false;
  }
}
