-- 직관 다이어리 v1 — 직관 스토리와 독립적인 영구 방문 기록.
--
-- 적용 순서 주의: PR 리뷰 전 production 적용 금지.
-- 기존 create_venue_story RPC는 배포 롤링 구간 호환을 위해 유지하고,
-- 새 route만 create_venue_story_v2를 사용한다. 기존 RPC로 생성된 행은
-- legacy_unclassified라 직관 승률에 포함되지 않는다(fail-closed).

ALTER TABLE venue_stories
  ADD COLUMN IF NOT EXISTS attendance_source TEXT NOT NULL DEFAULT 'legacy_unclassified'
    CHECK (attendance_source IN ('legacy_unclassified', 'story_geofence', 'admin_qa')),
  ADD COLUMN IF NOT EXISTS favorite_team_id_snapshot INT,
  ADD COLUMN IF NOT EXISTS game_date DATE;

COMMENT ON COLUMN venue_stories.attendance_source IS
  '직관 기록 자격: story_geofence=실제 GPS 통과, admin_qa=관리자 우회, legacy_unclassified=구버전 생성';
COMMENT ON COLUMN venue_stories.favorite_team_id_snapshot IS
  '스토리 생성 트랜잭션 시 profiles.team_id 스냅샷. 이후 팀 변경과 무관한 직관 승패 계산용.';
COMMENT ON COLUMN venue_stories.game_date IS
  '서버가 실제 KBO 경기 조회로 확인한 경기일. 직관 다이어리 시즌 조회용.';

CREATE TABLE IF NOT EXISTS venue_attendance (
  id                         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_id                    TEXT NOT NULL,
  game_date                  DATE NOT NULL,
  favorite_team_id_snapshot  INT,
  stadium_name               TEXT,
  source                     TEXT NOT NULL CHECK (source = 'story_geofence'),
  recorded_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_venue_attendance_user_date
  ON venue_attendance (user_id, game_date DESC);

-- 상세 직관 이력은 본인 전용 API(service_role)만 조회한다. 공개 RLS 정책은 두지 않는다.
ALTER TABLE venue_attendance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE venue_attendance FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE venue_attendance IS
  '실제 지오펜스 인증 직관의 영구 기록. 스토리 미디어/캡션과 FK를 보관하지 않아 스토리 정리와 독립적.';

-- story가 active가 되는 동일 DB 트랜잭션에서 영구 기록한다.
-- image는 INSERT(active), video는 검증 성공 UPDATE(pending→active)에서 실행된다.
CREATE OR REPLACE FUNCTION record_venue_attendance_from_story()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'active'
     OR NEW.attendance_source <> 'story_geofence'
     OR NEW.game_date IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO venue_attendance (
    user_id, game_id, game_date, favorite_team_id_snapshot, stadium_name, source
  ) VALUES (
    NEW.user_id, NEW.game_id, NEW.game_date,
    NEW.favorite_team_id_snapshot, NEW.stadium_name, 'story_geofence'
  )
  ON CONFLICT (user_id, game_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION record_venue_attendance_from_story() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_record_venue_attendance ON venue_stories;
CREATE TRIGGER trg_record_venue_attendance
AFTER INSERT OR UPDATE OF status ON venue_stories
FOR EACH ROW EXECUTE FUNCTION record_venue_attendance_from_story();

-- v2 생성 RPC: 기존 게임당 상한/락 계약을 유지하면서 실제 GPS 출처·경기일·최애팀을
-- story 행에 원자적으로 스냅샷한다. active trigger가 같은 트랜잭션에서 attendance를 만든다.
CREATE OR REPLACE FUNCTION create_venue_story_v2(
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
  p_max_per_game INT,
  p_consent_version SMALLINT,
  p_needs_transcode BOOLEAN,
  p_attendance_source TEXT,
  p_game_date DATE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count   INT;
  v_id      BIGINT;
  v_team_id INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_game_id, 0));

  SELECT count(*) INTO v_count
    FROM venue_stories
   WHERE user_id = p_user_id AND game_id = p_game_id
     AND status IN ('active', 'pending');

  IF v_count >= p_max_per_game THEN
    RETURN jsonb_build_object('ok', false, 'error', 'limit');
  END IF;

  SELECT team_id INTO v_team_id
    FROM profiles
   WHERE id = p_user_id;

  INSERT INTO venue_stories (
    game_id, user_id, media_type, media_url, media_bucket, media_path,
    thumb_url, thumb_bucket, thumb_path, duration_ms, width, height, caption,
    venue_verified, stadium_name, status, expires_at, consent_version, consent_at,
    needs_transcode, attendance_source, favorite_team_id_snapshot, game_date
  ) VALUES (
    p_game_id, p_user_id, p_media_type, p_media_url, p_media_bucket, p_media_path,
    p_thumb_url, p_thumb_bucket, p_thumb_path, p_duration_ms, p_width, p_height, p_caption,
    p_attendance_source = 'story_geofence', p_stadium_name, p_status, p_expires_at,
    p_consent_version, now(), p_needs_transcode, p_attendance_source, v_team_id, p_game_date
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION create_venue_story_v2(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INT, SMALLINT, BOOLEAN, TEXT, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_venue_story_v2(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INT, SMALLINT, BOOLEAN, TEXT, DATE)
  TO service_role;

-- 최애선수 미출전과 적재 대기를 구분하는 경기별 ingest 완료 신호.
-- player_game_logs 원문은 반환하지 않고 요청한 경기 중 1행 이상 적재된 game_id만 반환한다.
CREATE OR REPLACE FUNCTION get_games_with_player_logs(p_game_ids TEXT[])
RETURNS TABLE (game_id TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT DISTINCT pgl.game_id
    FROM player_game_logs pgl
   WHERE pgl.game_id = ANY(p_game_ids);
$$;

REVOKE ALL ON FUNCTION get_games_with_player_logs(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_games_with_player_logs(TEXT[]) TO service_role;
