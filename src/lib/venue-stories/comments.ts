// 직관 라이브 스토리 댓글 — 공유 타입 + 순수 로직(스모크 대상)

export const VENUE_STORY_COMMENT_MAX_LENGTH = 200;
export const VENUE_STORY_COMMENT_LIST_LIMIT = 100; // 스토리당 조회 상한(안전 limit)

// 어뷰징 가드 — 기존 커뮤니티 댓글 정책(CommentSheet handleSubmit)과 동일 상수:
// 10초 간격 쿨다운 + 슬라이딩 윈도우 60초 내 3건
export const VENUE_STORY_COMMENT_COOLDOWN_MS = 10_000;
export const VENUE_STORY_COMMENT_WINDOW_MS = 60_000;
export const VENUE_STORY_COMMENT_MAX_IN_WINDOW = 3;

/** GET /api/venue-stories/[id]/comments 응답 아이템 */
export interface VenueStoryComment {
  id: number;
  storyId: number;
  userId: string;
  content: string;
  createdAt: string;
  author: {
    nickname: string | null;
    avatarUrl: string | null;
    teamId: number | null;
  };
}

/** 댓글 본문 검증 — trim 후 1~200자. 실패 시 사용자용 에러 메시지 반환. */
export function validateCommentContent(
  raw: unknown,
): { ok: true; content: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "댓글 내용이 필요해요" };
  }
  const content = raw.trim();
  if (content.length === 0) {
    return { ok: false, error: "댓글 내용이 필요해요" };
  }
  if (content.length > VENUE_STORY_COMMENT_MAX_LENGTH) {
    return {
      ok: false,
      error: `댓글은 ${VENUE_STORY_COMMENT_MAX_LENGTH}자까지 쓸 수 있어요`,
    };
  }
  return { ok: true, content };
}

/** 삭제 권한 계약(RLS/API 공용): 본인 또는 관리자만 */
export function canDeleteComment(
  commentUserId: string,
  requesterId: string | null,
  isAdmin: boolean,
): boolean {
  if (isAdmin) return true;
  return requesterId != null && requesterId === commentUserId;
}

/**
 * 최신 100개를 DESC 로 조회한 결과를 채팅처럼 정순(오래된→최신)으로 반전.
 * GET /comments 응답 정렬 계약 — 101개 이상일 때 "최신 100개"가 보장되도록
 * DB 는 DESC LIMIT 로 자르고, 화면 정렬만 여기서 뒤집는다.
 */
export function toChronological<T>(rowsDesc: readonly T[]): T[] {
  return [...rowsDesc].reverse();
}

/**
 * 어뷰징 가드 순수 판정 — 과거 작성 시각 목록과 now 를 받아
 * (1) 마지막 작성 후 10초 미만이면 차단 (2) 60초 내 3건 이상이면 차단.
 * 허용 시 now 를 기록한 갱신 목록을 반환한다(호출자가 저장).
 */
export function evaluateCommentRate(
  timestamps: readonly number[],
  now: number,
): { allowed: boolean; timestamps: number[] } {
  const recent = timestamps.filter(
    (t) => now - t < VENUE_STORY_COMMENT_WINDOW_MS,
  );
  const last = timestamps.length > 0 ? Math.max(...timestamps) : null;
  if (last != null && now - last < VENUE_STORY_COMMENT_COOLDOWN_MS) {
    return { allowed: false, timestamps: recent };
  }
  if (recent.length >= VENUE_STORY_COMMENT_MAX_IN_WINDOW) {
    return { allowed: false, timestamps: recent };
  }
  return { allowed: true, timestamps: [...recent, now] };
}

/** 노출 댓글 수 집계 — soft delete(deleted_at) 행 제외 */
export function countVisibleComments(
  rows: readonly { deleted_at: string | null }[],
): number {
  return rows.filter((r) => r.deleted_at == null).length;
}
