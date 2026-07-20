-- 직관 라이브 (Venue Stories) — Slice 1
--
-- 직관 온 팬이 경기별로 짧은 클립/사진을 올리면 경기 상세 하단 "직관 라이브"에서
-- 스토리처럼 넘겨본다. 경기 끝나면 자동 삭제(서버비 절약).
--
-- 미디어 파일은 클라가 기존 storage 버킷(videos/photos)의 *본인 예약 경로*
-- (venue-stories/{gameId}/{userId}/...)에 업로드하고, 이 행의 생성/조회/신고/삭제/정리는
-- 전부 API route(admin/service_role)가 소유한다. 생성 API 가 경로 prefix=업로더 소유를 강제해
-- 타인 미디어 참조·삭제를 차단한다. 클라 RLS 정책은 없다(service_role 전용).

CREATE TABLE IF NOT EXISTS venue_stories (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id      TEXT NOT NULL,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_type   TEXT NOT NULL CHECK (media_type IN ('video', 'image')),
  media_url    TEXT NOT NULL,
  media_bucket TEXT NOT NULL,
  media_path   TEXT NOT NULL,
  thumb_url    TEXT,
  thumb_bucket TEXT,
  thumb_path   TEXT,
  duration_ms  INT,
  width        INT,
  height       INT,
  caption      TEXT,
  -- 지오펜스: 업로드 시 구장 반경 안에서 GPS 검증됐는지(직관 인증). fail-closed 라 항상 true.
  venue_verified BOOLEAN NOT NULL DEFAULT false,
  -- 실제 경기 스케줄에서 확인한 구장명(S_NM). 홈팀=홈구장 가정 대신 실제 개최 구장.
  stadium_name TEXT,
  report_count INT NOT NULL DEFAULT 0,
  transcode_attempts INT NOT NULL DEFAULT 0,
  -- pending: 영상 트랜스코딩(720p)·duration 검증 대기(노출 안 함)
  -- active: 노출 / removed: 신고 임계·어드민·본인삭제·검증실패 → 정리 대상
  -- cleanup_failed: storage 삭제 실패 → 다음 정리 cron 재시도
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('pending', 'active', 'removed', 'cleanup_failed')),
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

-- 정리 대상(removed/cleanup_failed) 스캔용
CREATE INDEX IF NOT EXISTS idx_venue_stories_status
  ON venue_stories (status);

-- 트랜스코딩 워커: pending 영상 스캔
CREATE INDEX IF NOT EXISTS idx_venue_stories_pending
  ON venue_stories (created_at)
  WHERE status = 'pending' AND media_type = 'video';

-- 게임당 유저 상한(스팸 방지) 카운트용
CREATE INDEX IF NOT EXISTS idx_venue_stories_user_game
  ON venue_stories (user_id, game_id)
  WHERE status IN ('active', 'pending');

-- 클라 직접 접근 0 — RLS 활성화하되 정책은 두지 않는다(service_role 전용).
ALTER TABLE venue_stories ENABLE ROW LEVEL SECURITY;

-- ── 신고 원자 처리 RPC ──────────────────────────────────────────────
-- reports insert(중복 방지) + report_count 증가 + 임계(3) 자동 숨김을 한 트랜잭션으로.
-- 동시 신고 유실/재신고 영구차단(비원자 read-modify-write) 방지.
CREATE OR REPLACE FUNCTION report_venue_story(
  p_story_id BIGINT,
  p_reporter UUID,
  p_reason   TEXT,
  p_detail   TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists BOOLEAN;
  v_rows   INT;
  v_count  INT;
  v_hidden BOOLEAN := false;
BEGIN
  SELECT true INTO v_exists FROM venue_stories WHERE id = p_story_id;
  IF v_exists IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  INSERT INTO reports (reporter_id, target_type, target_id, reason, detail)
  VALUES (p_reporter, 'venue_story', p_story_id::text, p_reason, p_detail)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok', true, 'alreadyReported', true);
  END IF;

  UPDATE venue_stories
     SET report_count = report_count + 1,
         status = CASE
                    WHEN report_count + 1 >= 3 AND status = 'active' THEN 'removed'
                    ELSE status
                  END
   WHERE id = p_story_id
   RETURNING report_count, (status = 'removed') INTO v_count, v_hidden;

  RETURN jsonb_build_object('ok', true, 'reportCount', v_count, 'hidden', v_hidden);
END;
$$;

REVOKE ALL ON FUNCTION report_venue_story(BIGINT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_venue_story(BIGINT, UUID, TEXT, TEXT) TO service_role;

-- ── 생성 원자 처리 RPC ──────────────────────────────────────────────
-- 게임당 유저 상한(active+pending) 체크 + insert 를 advisory lock 으로 원자화.
-- count 후 별도 insert 하던 route 로직의 동시요청 초과(스팸/Storage 비용 우회)를 하드리밋으로.
CREATE OR REPLACE FUNCTION create_venue_story(
  p_game_id      TEXT,
  p_user_id      UUID,
  p_media_type   TEXT,
  p_media_url    TEXT,
  p_media_bucket TEXT,
  p_media_path   TEXT,
  p_thumb_url    TEXT,
  p_thumb_bucket TEXT,
  p_thumb_path   TEXT,
  p_duration_ms  INT,
  p_width        INT,
  p_height       INT,
  p_caption      TEXT,
  p_stadium_name TEXT,
  p_status       TEXT,
  p_expires_at   TIMESTAMPTZ,
  p_max_per_game INT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
  v_id    BIGINT;
BEGIN
  -- (user, game) 단위 트랜잭션 advisory lock — 같은 유저·경기의 동시 생성 직렬화
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_game_id, 0));

  SELECT count(*) INTO v_count
    FROM venue_stories
   WHERE user_id = p_user_id AND game_id = p_game_id
     AND status IN ('active', 'pending');

  IF v_count >= p_max_per_game THEN
    RETURN jsonb_build_object('ok', false, 'error', 'limit');
  END IF;

  INSERT INTO venue_stories (
    game_id, user_id, media_type, media_url, media_bucket, media_path,
    thumb_url, thumb_bucket, thumb_path, duration_ms, width, height, caption,
    venue_verified, stadium_name, status, expires_at
  ) VALUES (
    p_game_id, p_user_id, p_media_type, p_media_url, p_media_bucket, p_media_path,
    p_thumb_url, p_thumb_bucket, p_thumb_path, p_duration_ms, p_width, p_height, p_caption,
    true, p_stadium_name, p_status, p_expires_at
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION create_venue_story(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_venue_story(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INT) TO service_role;
