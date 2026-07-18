// 직관 라이브 (Venue Stories) — 공유 타입 + 상수

export const VENUE_STORY_MAX_DURATION_MS = 15_000; // 영상 15초
export const VENUE_STORY_DURATION_TOLERANCE_MS = 1_000; // 클라 duration 반올림 여유
export const VENUE_STORY_MAX_BYTES = 60 * 1024 * 1024; // 60MB
export const VENUE_STORY_TTL_HOURS = 8; // 업로드 후 만료(경기 종료 후 정리)
export const VENUE_STORY_MAX_PER_USER_PER_GAME = 10; // 게임당 유저 상한(스팸 방지)
export const VENUE_STORY_REPORT_HIDE_THRESHOLD = 3; // 신고 누적 자동 숨김
export const VENUE_STORY_IMAGE_HOLD_MS = 5_000; // 사진 스토리 자동 진행 시간

export type VenueStoryMediaType = "video" | "image";

/** GET /api/venue-stories 응답 아이템 */
export interface VenueStory {
  id: number;
  gameId: string;
  userId: string;
  mediaType: VenueStoryMediaType;
  mediaUrl: string;
  thumbUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  createdAt: string;
  author: {
    nickname: string | null;
    avatarUrl: string | null;
    teamId: number | null;
  };
}

/** POST /api/venue-stories 요청 바디 */
export interface CreateVenueStoryBody {
  gameId: string;
  mediaType: VenueStoryMediaType;
  mediaUrl: string;
  thumbUrl?: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  caption?: string | null;
}
