-- 직관 라이브 (Venue Stories) — Slice 1 (MVP)
--
-- 직관 온 팬이 경기별로 짧은 클립/사진을 올리면 경기 상세 하단 "직관 라이브"에서
-- 스토리처럼 넘겨본다. 경기 끝나면(업로드 +TTL) 자동 삭제(서버비 절약).
--
-- 미디어 파일 자체는 클라가 기존 storage 버킷(videos/photos)에 직접 업로드하고(버킷 RLS=authed insert),
-- 이 행의 생성/조회/신고/삭제/정리는 전부 API route(admin/service_role)가 소유한다.
-- 따라서 클라 RLS 정책은 두지 않는다(video_transcode_jobs 패턴 — 클라 직접 접근 0).

CREATE TABLE IF NOT EXISTS venue_stories (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id      TEXT NOT NULL,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_type   TEXT NOT NULL CHECK (media_type IN ('video', 'image')),
  -- 공개 URL + 정확한 정리를 위한 버킷/경로(만료 cron 이 storage 오브젝트를 정밀 삭제)
  media_url    TEXT NOT NULL,
  media_bucket TEXT NOT NULL,
  media_path   TEXT NOT NULL,
  -- 영상 포스터(썸네일). 사진은 media_url 과 동일하거나 별도 압축본.
  thumb_url    TEXT,
  thumb_bucket TEXT,
  thumb_path   TEXT,
  duration_ms  INT,
  width        INT,
  height       INT,
  caption      TEXT,
  -- 지오펜스: 업로드 시 구장 반경 안에서 GPS 검증됐는지(직관 인증). 중립/올스타 등
  -- 구장 좌표 미매핑 게임은 검증 없이 허용(false).
  venue_verified BOOLEAN NOT NULL DEFAULT false,
  report_count INT NOT NULL DEFAULT 0,
  -- active: 노출 / removed: 신고 임계·어드민·본인삭제 대기(cron 이 storage 까지 정리)
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- 경기별 active 스토리 최신순 조회
CREATE INDEX IF NOT EXISTS idx_venue_stories_game_active
  ON venue_stories (game_id, created_at DESC)
  WHERE status = 'active';

-- 만료/정리 cron 스캔용
CREATE INDEX IF NOT EXISTS idx_venue_stories_expiry
  ON venue_stories (expires_at);

-- 게임당 유저 스토리 상한(스팸 방지) 카운트용
CREATE INDEX IF NOT EXISTS idx_venue_stories_user_game
  ON venue_stories (user_id, game_id)
  WHERE status = 'active';

-- 클라 직접 접근 0 — RLS 활성화하되 정책은 두지 않는다(service_role 전용).
ALTER TABLE venue_stories ENABLE ROW LEVEL SECURITY;
