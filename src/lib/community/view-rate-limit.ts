/**
 * 조회수 증가 route 경량 abuse cap (인스턴스 로컬 · best-effort) — 2026-07-21 삼순 blocker3.
 *
 * 서버리스라 인스턴스 간 공유 상태는 없으므로 완전 방어는 아니다(그 층은 RPC를
 * service_role only로 잠근 v2 마이그레이션이 담당). 여기선 단일 클라이언트가 한
 * route 인스턴스로 같은 (viewer, post, kind)를 초단위 폭주시키는 것만 막는다.
 *
 * 판정은 순수 함수(shouldAllowView)로 분리해 테스트 가능하게 한다.
 */

/** 같은 (key)로 windowMs 안에 already가 기록돼 있으면 차단. */
export function shouldAllowView(lastSeenMs: number | undefined, nowMs: number, windowMs: number): boolean {
  if (lastSeenMs === undefined) return true;
  return nowMs - lastSeenMs >= windowMs;
}

const WINDOW_MS = 1000; // 같은 viewer+post+kind는 1초당 최대 1회 증가 허용
const MAX_ENTRIES = 5000; // 메모리 상한 — 초과 시 가장 오래된 절반 제거

const seen = new Map<string, number>();

function evictIfNeeded() {
  if (seen.size <= MAX_ENTRIES) return;
  // 삽입 순서 = 대략 시간순. 앞쪽 절반(오래된) 제거.
  const drop = Math.floor(seen.size / 2);
  let i = 0;
  for (const k of seen.keys()) {
    seen.delete(k);
    if (++i >= drop) break;
  }
}

/**
 * route 진입점: 이 요청을 허용할지. 허용 시 타임스탬프 기록.
 * key = `${viewerToken}:${postId}:${kind}` (viewerToken = IP 등 요청자 식별 힌트).
 */
export function allowViewRequest(viewerToken: string, postId: number, kind: string, nowMs = Date.now()): boolean {
  const key = `${viewerToken}:${postId}:${kind}`;
  const last = seen.get(key);
  if (!shouldAllowView(last, nowMs, WINDOW_MS)) return false;
  seen.set(key, nowMs);
  evictIfNeeded();
  return true;
}
