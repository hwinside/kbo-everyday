// 직관 라이브 스토리 댓글 — 공유 타입 + 순수 로직(스모크 대상)

export const VENUE_STORY_COMMENT_MAX_LENGTH = 200;
export const VENUE_STORY_COMMENT_LIST_LIMIT = 100; // 스토리당 조회 상한(안전 limit)

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

/** 노출 댓글 수 집계 — soft delete(deleted_at) 행 제외 */
export function countVisibleComments(
  rows: readonly { deleted_at: string | null }[],
): number {
  return rows.filter((r) => r.deleted_at == null).length;
}
