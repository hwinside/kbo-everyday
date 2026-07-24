// 직관 라이브 스토리 댓글 — 공유 타입 + 순수 로직(스모크 대상)
import { normalizeForFloodKey } from "@/lib/utils/normalize-message";

export const VENUE_STORY_COMMENT_MAX_LENGTH = 200;
export const VENUE_STORY_COMMENT_LIST_LIMIT = 100; // 스토리당 조회 상한(안전 limit)

// 어뷰징 가드 — 기존 커뮤니티 댓글 정책(CommentSheet handleSubmit)과 동일 상수:
// 10초 간격 쿨다운 + 슬라이딩 윈도우 60초 내 3건
export const VENUE_STORY_COMMENT_COOLDOWN_MS = 10_000;
export const VENUE_STORY_COMMENT_WINDOW_MS = 60_000;
export const VENUE_STORY_COMMENT_MAX_IN_WINDOW = 3;
// CommentSheet 와 동일 — 정규화 키 기준 최근 5건 내 같은 내용 반복 차단
export const VENUE_STORY_COMMENT_DUP_RECENT = 5;

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

/**
 * 스토리 댓글 수명주기 게이트(GET/POST 공용) — active 상태 + 미만료 스토리만
 * 댓글 조회/작성 가능. 만료·비활성·부재 스토리는 404 로 닫는다(삼순 #807 blocker 2).
 */
export function isStoryOpenForComments(
  story: { status?: unknown; expires_at?: unknown } | null | undefined,
  now = Date.now(),
): boolean {
  if (!story || story.status !== "active") return false;
  const expires = new Date(story.expires_at as string).getTime();
  return Number.isFinite(expires) && expires > now;
}

/** 어뷰징 판정 입력 — DB에서 조회한 유저 최근 댓글(최신순) */
export interface RecentCommentRow {
  content: string;
  created_at: string;
}

/**
 * DB 권위 어뷰징 판정(삼순 #807 blocker 3) — 서버리스 인스턴스 메모리가 아니라
 * 유저의 최근 댓글 행(created_at/content)을 근거로 판정한다:
 * (1) 10초 간격 / 60초 내 3건 rate 차단 (2) 정규화 키 기준 최근 5건 동일내용 반복 차단.
 * 정책 상수는 기존 커뮤니티 CommentSheet 와 동일.
 */
export function evaluateCommentAbuse(
  recentDesc: readonly RecentCommentRow[],
  content: string,
  now: number,
): { allowed: true } | { allowed: false; error: string } {
  const timestamps = recentDesc
    .map((r) => new Date(r.created_at).getTime())
    .filter((t) => Number.isFinite(t));
  if (!evaluateCommentRate(timestamps, now).allowed) {
    return { allowed: false, error: "잠시 후 다시 입력해 주세요" };
  }
  const key = normalizeForFloodKey(content);
  const dup = recentDesc
    .slice(0, VENUE_STORY_COMMENT_DUP_RECENT)
    .some((r) => normalizeForFloodKey(r.content) === key);
  if (dup) {
    return { allowed: false, error: "같은 댓글은 반복해서 달 수 없어요" };
  }
  return { allowed: true };
}

/**
 * 전송 중 스토리 전환 오염 가드(삼순 #807 라운드3 blocker 3) —
 * POST 시작 시점에 캡처한 story id 와 응답 도착 시점의 현재 story id 가
 * 일치할 때만 댓글 목록/카운트에 반영한다(A 응답이 B UI 를 오염하지 않게).
 */
export function shouldApplyCommentResponse(
  requestStoryId: number,
  currentStoryId: number | null | undefined,
): boolean {
  return currentStoryId != null && requestStoryId === currentStoryId;
}

/**
 * 목록/오버레이 하단 스크롤(삼순 #807 blocker 5) — DESC→정순 반전 렌더에서
 * 최신 댓글이 입력창 바로 위에 보이도록 컨테이너를 맨 아래로 내린다.
 */
export function scrollToLatest(
  el: { scrollTop: number; readonly scrollHeight: number } | null,
): void {
  if (el) el.scrollTop = el.scrollHeight;
}

/** 노출 댓글 수 집계 — soft delete(deleted_at) 행 제외 */
export function countVisibleComments(
  rows: readonly { deleted_at: string | null }[],
): number {
  return rows.filter((r) => r.deleted_at == null).length;
}
