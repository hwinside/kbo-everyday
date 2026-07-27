-- 직관 다이어리 A2 — 2026 종료 경기 owner-only 직접 추가.
--
-- production 선적용 금지. PR 리뷰·하린아빠 머지 승인 뒤 배포한다.
-- 직접 추가 미디어는 처음부터 diary-only이며 공개 active 상태를 거치지 않는다.

ALTER TABLE venue_stories
  DROP CONSTRAINT IF EXISTS venue_stories_attendance_source_check;
ALTER TABLE venue_stories
  ADD CONSTRAINT venue_stories_attendance_source_check
  CHECK (
    attendance_source IN (
      'legacy_unclassified',
      'story_geofence',
      'admin_qa',
      'diary_manual'
    )
  );

-- 직접 추가 archived 행은 검증·승격이 끝난 venue-media 객체만 허용한다.
-- pending staging 영상이 cleanup 경로에서 잘못 archived/출석 기록되는 것을 DB에서 차단한다.
ALTER TABLE venue_stories
  DROP CONSTRAINT IF EXISTS venue_stories_manual_archive_private_check;
ALTER TABLE venue_stories
  ADD CONSTRAINT venue_stories_manual_archive_private_check
  CHECK (
    attendance_source <> 'diary_manual'
    OR status <> 'archived'
    OR media_bucket = 'venue-media'
  );

ALTER TABLE venue_attendance
  DROP CONSTRAINT IF EXISTS venue_attendance_source_check;
ALTER TABLE venue_attendance
  ADD CONSTRAINT venue_attendance_source_check
  CHECK (source IN ('story_geofence', 'diary_manual'));

COMMENT ON COLUMN venue_stories.attendance_source IS
  'story_geofence=실시간 GPS 인증, diary_manual=종료 경기 직접 추가, admin_qa=관리자 우회, legacy_unclassified=구버전';
COMMENT ON COLUMN venue_attendance.source IS
  'story_geofence=GPS 인증 직관, diary_manual=본인 과거 경기 직접 추가. GPS가 우선하며 수동으로 강등하지 않는다.';

-- active+pending+archived 전체 상한 카운트용. 기존 active+pending partial index는
-- 라이브 업로드 경로를 위해 유지한다.
CREATE INDEX IF NOT EXISTS idx_venue_stories_user_game_retained
  ON venue_stories (user_id, game_id)
  WHERE status IN ('active', 'pending', 'archived');

-- GPS live story(active)와 직접 추가(archived)를 모두 개인 직관 기록으로 만든다.
-- 동일 경기에서 수동 기록이 먼저 있은 뒤 GPS 인증이 생기면 GPS로 승격하며,
-- 반대 방향(인증→수동)은 절대 강등하지 않는다.
CREATE OR REPLACE FUNCTION record_venue_attendance_from_story()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source TEXT;
BEGIN
  IF NEW.game_date IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'active' AND NEW.attendance_source = 'story_geofence' THEN
    v_source := 'story_geofence';
  ELSIF NEW.status = 'archived' AND NEW.attendance_source = 'diary_manual' THEN
    v_source := 'diary_manual';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO venue_attendance (
    user_id, game_id, game_date, favorite_team_id_snapshot, stadium_name, source
  ) VALUES (
    NEW.user_id, NEW.game_id, NEW.game_date,
    NEW.favorite_team_id_snapshot, NEW.stadium_name, v_source
  )
  ON CONFLICT (user_id, game_id) DO UPDATE
     SET source = EXCLUDED.source,
         game_date = EXCLUDED.game_date,
         favorite_team_id_snapshot = EXCLUDED.favorite_team_id_snapshot,
         stadium_name = EXCLUDED.stadium_name,
         recorded_at = now()
   WHERE venue_attendance.source = 'diary_manual'
     AND EXCLUDED.source = 'story_geofence';

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION record_venue_attendance_from_story()
  FROM PUBLIC, anon, authenticated;

-- 직접 추가 전용 RPC. API가 검증한 값만 service_role로 전달하며,
-- advisory lock 안에서 보존 상태 전체를 세어 게임당 10개 불변식을 유지한다.
CREATE OR REPLACE FUNCTION create_venue_diary_manual_story(
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
  p_expires_at   TIMESTAMPTZ,
  p_max_per_game INT,
  p_consent_version SMALLINT,
  p_game_date    DATE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count   INT;
  v_id      BIGINT;
  v_team_id INT;
  v_status  TEXT;
BEGIN
  IF p_media_type NOT IN ('image', 'video') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'media_type');
  END IF;

  v_status := CASE WHEN p_media_type = 'video' THEN 'pending' ELSE 'archived' END;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_game_id, 0)
  );

  SELECT count(*) INTO v_count
    FROM venue_stories
   WHERE user_id = p_user_id
     AND game_id = p_game_id
     AND status IN ('active', 'pending', 'archived');

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
    needs_transcode, attendance_source, favorite_team_id_snapshot, game_date,
    archived_at, game_ended_at
  ) VALUES (
    p_game_id, p_user_id, p_media_type, p_media_url, p_media_bucket, p_media_path,
    p_thumb_url, p_thumb_bucket, p_thumb_path, p_duration_ms, p_width, p_height, p_caption,
    false, p_stadium_name, v_status,
    GREATEST(p_expires_at, now() + interval '7 days'),
    p_consent_version, now(),
    false, 'diary_manual', v_team_id, p_game_date,
    CASE WHEN v_status = 'archived' THEN now() ELSE NULL END,
    now()
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION create_venue_diary_manual_story(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  INT, INT, INT, TEXT, TEXT, TIMESTAMPTZ, INT, SMALLINT, DATE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_venue_diary_manual_story(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  INT, INT, INT, TEXT, TEXT, TIMESTAMPTZ, INT, SMALLINT, DATE
) TO service_role;

-- 라이브 RPC도 같은 보존 상태 전체를 세게 맞춘다. 일반 유저는 종료 경기 라이브 업로드가
-- 막혀 있지만 관리자 QA 우회가 archived 뒤 active를 추가해 10개를 넘기는 예외까지 닫는다.
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
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_game_id, 0)
  );

  SELECT count(*) INTO v_count
    FROM venue_stories
   WHERE user_id = p_user_id
     AND game_id = p_game_id
     AND status IN ('active', 'pending', 'archived');

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

REVOKE ALL ON FUNCTION create_venue_story_v2(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  INT, INT, INT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INT, SMALLINT, BOOLEAN, TEXT, DATE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_venue_story_v2(
  TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  INT, INT, INT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INT, SMALLINT, BOOLEAN, TEXT, DATE
) TO service_role;
