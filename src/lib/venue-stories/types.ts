// 직관 라이브 (Venue Stories) — 공유 타입 + 상수
import type { UploadGateKind } from "./geofence";
export type { UploadGateKind };

export const VENUE_STORY_MAX_DURATION_MS = 15_000; // 영상 15초
export const VENUE_STORY_DURATION_TOLERANCE_MS = 1_000; // 클라 duration 반올림 여유
// Supabase Storage 프로젝트 전역 상한(50MiB)과 동일하게 유지한다.
// 앱 상한이 더 크면 클라이언트 검증을 통과해도 Storage가 413으로 거부한다.
export const VENUE_STORY_MAX_BYTES = 50 * 1024 * 1024; // 50MiB
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
// 만료 계약(하린아빠 스펙 2026-07-20): **경기 종료 +24h** — terminal(final/cancelled) 전에는 expiry 삭제 금지.
// - finalize cron 이 terminal 전이를 CAS(game_ended_at IS NULL 가드)로 확정한 뒤에만 만료=감지+24h 확정.
// - 종료 감지 전 expires_at 은 **시작+72h 안전상한**(장애 정책·관제용, 정상 만료 조건 아님) —
//   여기 도달 = finalize 장애 신호로 cleanup 이 staleCap 관제(5xx) + 누수 방지 삭제를 수행한다.
export const VENUE_STORY_SAFETY_CAP_HOURS_AFTER_START = 72; // 종료 미감지 장애 안전상한(정상 만료 아님)
export const VENUE_STORY_EXPIRY_HOURS_AFTER_END = 24; // 종료 확정 후 만료까지

// 영상 원본 private staging 버킷(B+①): 서버 ffprobe 검증 통과 전까지 공개 URL 미부여.
// 통과 시에만 공개 videos 버킷으로 승격(원본 즉시 공개) → 720p 는 백그라운드 교체.
export const VENUE_STORY_STAGING_BUCKET = "venue-staging";
export const VENUE_STORY_PUBLIC_VIDEO_BUCKET = "videos";

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
  /**
   * 클라이언트 낚관 카드 전용(서버 응답에는 없음). 영상 업로드 직후 pending(검증 중)이라
   * GET 목록(active만 조회)에서 빠지는 구간을 '처리중' 카드로 즉시 노출하기 위해 사용.
   * active 승급 후 서버 목록이 반환하면 이 카드는 실제 카드로 교체된다.
   */
  processing?: boolean;
}

/** POST /api/venue-stories 요청 바디 */
export interface CreateVenueStoryBody {
  gameId: string;
  mediaType: VenueStoryMediaType;
  /** image 전용: 공개 버킷 URL. video 는 mediaPath(staging) 사용. */
  mediaUrl?: string | null;
  /** video 전용: private staging 버킷 내 본인 예약 경로(venue-stories/{gameId}/{userId}/{file}) */
  mediaPath?: string | null;
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
  // 취소 경기 여부 — 관리자 QA도 취소 경기는 fail-closed(시간창만 우회). 클라가 media prepare 전 차단해
  // 고아 객체/불필요 전송을 막는다(삼순 #832 왕복2).
  cancelled: boolean;
  // 업로드 차단 사유 종류 — 관리자 우회를 시간창(before/after)만 허용하고
  // cancelled/no-coord/no-time 은 관리자도 fail-closed 판정하기 위해 클라에 내린다(삼순 #832 왕복3).
  gateKind: UploadGateKind;
}
