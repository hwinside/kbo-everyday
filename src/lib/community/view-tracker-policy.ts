/**
 * 조회수 트래킹 순수 정책 (테스트 가능 · React/DOM 무관) — 2026-07-21.
 *
 * dedup 규칙(하린아빠 스펙):
 *  - click: 상세 진입마다 +1 (dedup 없음)
 *  - impression: 피드 카드 세로 ≥50% + 0.5초 dwell 시 +1, 동일 유저 + 세션당 글 1회
 *    · "동일 유저" = 로그인 userId / 비로그인 guestId
 */

/** 현재 유저 식별자 — 로그인 userId 우선, 없으면 게스트 id. */
export function viewerKeyOf(userId?: string | null, guestId?: string | null): string {
  if (userId) return `u:${userId}`;
  if (guestId) return `g:${guestId}`;
  return "g:anon";
}

/** impression 세션 dedup 키. */
export function impressionDedupKey(postId: number, viewerKey: string): string {
  return `impression:${postId}:${viewerKey}`;
}

/** 이 유저가 이 세션에서 아직 이 글 임프레션을 집계 안 했으면 true(집계 대상). */
export function shouldCountImpression(seen: Set<string>, postId: number, viewerKey: string): boolean {
  if (!Number.isInteger(postId) || postId <= 0) return false;
  return !seen.has(impressionDedupKey(postId, viewerKey));
}

/** 화면 표시용 합산 조회수(click + impression). 원본 집계는 분리 유지한다. */
export function postViewTotal(
  clickCount?: number | null,
  impressionCount?: number | null
): number {
  return (clickCount ?? 0) + (impressionCount ?? 0);
}

/**
 * 전송 수단 선택. sendBeacon이 없거나 큐잉 실패(false 반환) 시 fetch 폴백.
 * beaconAvailable: navigator.sendBeacon 존재 여부, beaconQueued: sendBeacon 반환값.
 */
export function pickTransport(beaconAvailable: boolean, beaconQueued: boolean): "beacon" | "fetch" {
  return beaconAvailable && beaconQueued ? "beacon" : "fetch";
}
