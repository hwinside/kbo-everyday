// 직관 라이브 — 목록 인증 판정 + UGC 동의 키 (순수, 클라/서버 공용, 단위 테스트 가능).
//
// 삼순 09:44 #3:
//  - 목록 GET 이 invalid bearer 를 익명으로 강등하면 차단 유저 필터가 꺼진다
//    → Authorization 헤더가 있는데 검증 실패면 401 로 거부(익명 강등 금지).
//  - Composer consent key 가 user id 없이 기기 공용이라 계정 전환 시 B 가 미체크해도
//    A 의 동의로 기록됐다 → key 를 user-scoped 로.

export type ListAuthDecision =
  | { kind: "anon" } // Authorization 헤더 자체가 없음 — 익명 조회 허용(차단필터 없음이 정상)
  | { kind: "reject" } // 헤더는 있는데 검증 실패 — 401 (익명 강등 금지)
  | { kind: "user"; userId: string }; // 검증 성공 — 차단 유저 필터 적용

export function decideListAuth(
  hasAuthHeader: boolean,
  verifiedUserId: string | null,
): ListAuthDecision {
  if (verifiedUserId) return { kind: "user", userId: verifiedUserId };
  if (hasAuthHeader) return { kind: "reject" };
  return { kind: "anon" };
}

/**
 * UGC 가이드라인 동의 localStorage key — 반드시 user-scoped.
 * userId 미상이면 null(기기 공용 기억 금지 — 계정 전환 시 타 계정 동의 상속 차단).
 */
export function consentStorageKey(version: number, userId: string | null): string | null {
  if (!userId) return null;
  return `venueStoryGuidelineAgreed_v${version}_${userId}`;
}
