// 직관 라이브 (Venue Stories) — 공유 타입 + 상수

export const VENUE_STORY_MAX_DURATION_MS = 15_000; // 영상 15초
export const VENUE_STORY_DURATION_TOLERANCE_MS = 1_000; // 클라 duration 반올림 여유
export const VENUE_STORY_MAX_BYTES = 60 * 1024 * 1024; // 60MB
export const VENUE_STORY_MAX_PER_USER_PER_GAME = 10; // 게임당 유저 상한(스팸 방지)
export const VENUE_STORY_REPORT_HIDE_THRESHOLD = 3; // 신고 누적 자동 숨김
// UGC 가이드라인 동의 버전 — 문구 변경 시 증을로 재동의 강제. 서버가 이 값 이상만 허용.
export const VENUE_STORY_CONSENT_VERSION = 1;
export const VENUE_STORY_IMAGE_HOLD_MS = 5_000; // 사진 스토리 자동 진행 시간

// 지오펜스(직관 인증) — 삼순 권고: 기본 700m, 대형 구장 최대 1km, GPS accuracy ≤300m
export const VENUE_GEOFENCE_DEFAULT_RADIUS_M = 700;
export const VENUE_GEOFENCE_MAX_RADIUS_M = 1_000;
export const VENUE_GEOFENCE_MAX_ACCURACY_M = 300;

// 업로드 가능 시간대(경기 기준)와 만료(경기 종료 후 유지)를 분리한다.
// 업로드 마감(시작+6h)이 곧 만료였던 문제(시작+5h59 업로드 → 1분 뒤 소멸) 해소.
export const VENUE_UPLOAD_WINDOW_BEFORE_MIN = 60; // 경기 시작 60분 전부터 업로드 가능
export const VENUE_UPLOAD_WINDOW_AFTER_HOURS = 6; // 경기 시작 +6h 까지 업로드 가능(종료+여유)
// 만료 정책(하린아빠 스펙 2026-07-20): **경기 종료 +24h**.
// - 종료 전: 시작+30h 안전상한(업로드 시 임시 값) — 종료 감지 전 조기삭제 방지
// - finalize cron 이 종료(final/cancelled) 감지 시 game_ended_at 확정 → 만료=종료감지+24h 로 재설정
export const VENUE_STORY_EXPIRY_HOURS_AFTER_START = 30; // 종료 감지 전 임시 상한
export const VENUE_STORY_EXPIRY_HOURS_AFTER_END = 24; // 종료 확정 후 만료까지

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
  consentVersion?: number; // UGC 가이드라인 동의 버전(서버가 현재 버전과 정확히 일치하는 유한 정수만 허용)
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
