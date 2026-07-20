// 직관 라이브 (Venue Stories) — 공유 타입 + 상수

export const VENUE_STORY_MAX_DURATION_MS = 15_000; // 영상 15초
export const VENUE_STORY_DURATION_TOLERANCE_MS = 1_000; // 클라 duration 반올림 여유
export const VENUE_STORY_MAX_BYTES = 60 * 1024 * 1024; // 60MB
export const VENUE_STORY_MAX_PER_USER_PER_GAME = 10; // 게임당 유저 상한(스팸 방지)
export const VENUE_STORY_REPORT_HIDE_THRESHOLD = 3; // 신고 누적 자동 숨김
export const VENUE_STORY_IMAGE_HOLD_MS = 5_000; // 사진 스토리 자동 진행 시간

// 지오펜스(직관 인증) — 삼순 권고: 기본 700m, 대형 구장 최대 1km, GPS accuracy ≤300m
export const VENUE_GEOFENCE_DEFAULT_RADIUS_M = 700;
export const VENUE_GEOFENCE_MAX_RADIUS_M = 1_000;
export const VENUE_GEOFENCE_MAX_ACCURACY_M = 300;

// 업로드 가능 시간대(경기 기준) + 만료(경기 종료 기준)
export const VENUE_UPLOAD_WINDOW_BEFORE_MIN = 60; // 경기 시작 60분 전부터
export const VENUE_UPLOAD_WINDOW_AFTER_HOURS = 6; // 경기 시작 +6h 까지(종료+여유)
export const VENUE_STORY_EXPIRY_HOURS_AFTER_START = 6; // 만료 = 경기 시작 +6h

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
  venueVerified: boolean;
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
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
}

/** GET /api/venue-stories/venue?gameId= 응답 — 클라 지오펜스 프리체크·업로드 게이트용 */
export interface VenueInfo {
  gameId: string;
  stadiumName: string | null;
  lat: number | null;
  lng: number | null;
  radiusM: number;
  uploadOpen: boolean; // 업로드 가능 시간대인지
  reason: string | null; // uploadOpen=false 사유
}
