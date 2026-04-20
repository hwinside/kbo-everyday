/**
 * 이벤트 리더보드 — 글쓰기 트랙 포인트 SSOT
 *
 * 소스: docs/marketing/community-activation-event-draft.html L363~378
 *       (2026-04-20 하린아빠 & 삼순이 최종 GO — 공지값 그대로 고정)
 *
 * 원칙:
 * - 이 파일이 SSOT. 뷰/쿼리/UI/API 모두 이 상수 참조.
 * - 새 계산식 추가 금지 (삼순이 최종 GO 조건).
 * - 공지값 변경 시 이 파일만 수정하면 모든 소비처에 즉시 반영.
 */

/** 활동 유형별 1건당 포인트 */
export const WRITING_POINTS = {
  /** 경기 중계 채팅 (chat_messages 1row = 1pt) */
  CHAT_MESSAGE: 1,
  /** 커뮤니티 댓글 (comments 1row = 2pt) */
  COMMENT: 2,
  /** 커뮤니티 글 (posts where content_type <> 'photo' : 3pt) */
  POST_GENERAL: 3,
  /** 사진 게시판 사진글 (posts where content_type = 'photo' : 5pt) */
  POST_PHOTO: 5,
} as const

/** 활동 유형별 *일일* 포인트 상한 (KST 기준) */
export const WRITING_DAILY_CAPS = {
  CHAT_MESSAGE: 30,   // 하루 최대 30 chat
  COMMENT: 40,        // 하루 최대 20 comments
  POST_GENERAL: 30,   // 하루 최대 10 posts
  POST_PHOTO: 50,     // 하루 최대 10 photo posts
} as const

/** 전체 활동 합산 일일 상한 (KST 기준 하루) */
export const WRITING_TOTAL_DAILY_CAP = 150

/** 이벤트 기간 (KST) */
export const EVENT_PERIOD = {
  START: '2026-04-20T00:00:00+09:00',
  END:   '2026-05-31T23:59:59+09:00',
} as const

/**
 * SQL 템플릿 — Supabase view 생성용 참고.
 * 실제 view는 supabase/migrations/ 에서 관리.
 */
export const WRITING_POINTS_VIEW_NOTE = `
-- v_leaderboard_writing view 계산 로직 요약 (SSOT)
--
-- 1. 각 활동 테이블에서 이벤트 기간(KST) 내 행을 user_id + day로 GROUP BY
-- 2. 일일 캡 적용: LEAST(count * points, daily_cap)
-- 3. 합산 후 WRITING_TOTAL_DAILY_CAP(150)로 캡
-- 4. exclusion 7명 NOT IN 필터
--
-- 포인트 상수 변경 시 이 파일(writing-points.ts)만 수정 후
-- supabase view 재생성.
`.trim()
