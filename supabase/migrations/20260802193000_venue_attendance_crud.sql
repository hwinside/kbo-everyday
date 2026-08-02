-- 직관 기록 CRUD — 미디어와 독립된 원장 소프트 삭제 + 직접 등록 재등록.
-- production 선적용 금지. PR 리뷰·하린아빠 머지 승인 뒤 배포한다.

ALTER TABLE venue_attendance
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_venue_attendance_user_active_date
  ON venue_attendance (user_id, game_date DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN venue_attendance.deleted_at IS
  '사용자가 통계에서 제외한 시각. 원본 story/media는 유지하며 GPS trigger 재생성을 막기 위해 원장 행은 보존한다.';

-- 직접 등록 생성/재등록 전용. GPS 행은 삭제 상태여도 직접 등록으로 강등하지 않는다.
CREATE OR REPLACE FUNCTION upsert_venue_attendance_manual(
  p_user_id UUID,
  p_game_id TEXT,
  p_game_date DATE,
  p_favorite_team_id INT,
  p_stadium_name TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row venue_attendance%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_game_id, 0)
  );

  SELECT * INTO v_row
    FROM venue_attendance
   WHERE user_id = p_user_id AND game_id = p_game_id
   FOR UPDATE;

  IF FOUND AND v_row.source <> 'diary_manual' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'source_conflict');
  END IF;

  IF FOUND THEN
    UPDATE venue_attendance
       SET game_date = p_game_date,
           favorite_team_id_snapshot = p_favorite_team_id,
           stadium_name = p_stadium_name,
           deleted_at = NULL,
           updated_at = now(),
           recorded_at = now()
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  ELSE
    INSERT INTO venue_attendance (
      user_id, game_id, game_date, favorite_team_id_snapshot,
      stadium_name, source, updated_at
    ) VALUES (
      p_user_id, p_game_id, p_game_date, p_favorite_team_id,
      p_stadium_name, 'diary_manual', now()
    ) RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_row.id);
END;
$$;

REVOKE ALL ON FUNCTION upsert_venue_attendance_manual(UUID, TEXT, DATE, INT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION upsert_venue_attendance_manual(UUID, TEXT, DATE, INT, TEXT)
  TO service_role;

-- 직접 등록의 '경기 자체 변경'. 잘못 고른 경기를 고치는 유일한 경로다.
-- 원본 행과 대상 경기 키를 **정렬된 순서로** 둘 다 advisory lock 해 동시 이동/생성의
-- unique(user_id, game_id) race 와 교차 데드락을 함께 막는다.
CREATE OR REPLACE FUNCTION move_venue_attendance_manual_game(
  p_user_id UUID,
  p_id BIGINT,
  p_game_id TEXT,
  p_game_date DATE,
  p_favorite_team_id INT,
  p_stadium_name TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row    venue_attendance%ROWTYPE;
  v_target venue_attendance%ROWTYPE;
  v_keys   TEXT[];
  v_key    TEXT;
BEGIN
  SELECT * INTO v_row FROM venue_attendance WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.user_id <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  -- 같은 유저의 두 키를 항상 같은 순서로 잠근다(A→B 와 B→A 동시 실행 데드락 차단).
  SELECT array_agg(k ORDER BY k) INTO v_keys
    FROM (SELECT DISTINCT unnest(ARRAY[v_row.game_id, p_game_id]) AS k) s;
  FOREACH v_key IN ARRAY v_keys LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_key, 0));
  END LOOP;

  -- 잠근 뒤 원본을 다시 읽어 잠금 전 상태로 판정하지 않는다.
  SELECT * INTO v_row FROM venue_attendance WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_row.user_id <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_row.source <> 'diary_manual' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'source_immutable');
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'deleted');
  END IF;

  IF v_row.game_id <> p_game_id THEN
    SELECT * INTO v_target
      FROM venue_attendance
     WHERE user_id = p_user_id AND game_id = p_game_id
     FOR UPDATE;

    IF FOUND THEN
      -- GPS 인증 기록은 삭제 상태여도 수동 이동으로 덮지 않는다(강등 금지).
      IF v_target.source <> 'diary_manual' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_gps_conflict');
      END IF;
      IF v_target.deleted_at IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_duplicate');
      END IF;
      -- 대상 경기의 삭제된 수동 tombstone 만 회수한다.
      DELETE FROM venue_attendance WHERE id = v_target.id;
    END IF;
  END IF;

  UPDATE venue_attendance
     SET game_id = p_game_id,
         game_date = p_game_date,
         favorite_team_id_snapshot = p_favorite_team_id,
         stadium_name = p_stadium_name,
         updated_at = now()
   WHERE id = v_row.id
     AND user_id = p_user_id
     AND source = 'diary_manual'
     AND deleted_at IS NULL
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_row.id);
END;
$$;

REVOKE ALL ON FUNCTION move_venue_attendance_manual_game(UUID, BIGINT, TEXT, DATE, INT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION move_venue_attendance_manual_game(UUID, BIGINT, TEXT, DATE, INT, TEXT)
  TO service_role;

-- 수동 기록이 이후 실제 GPS 인증으로 승격될 때만 삭제 상태도 해제한다.
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

  -- 직접 등록 RPC와 같은 키로 직렬화해 GPS 승격/수동 생성 동시 실행의 unique race를 막는다.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.user_id::text || ':' || NEW.game_id, 0)
  );

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
         recorded_at = now(),
         updated_at = now(),
         deleted_at = NULL
   WHERE venue_attendance.source = 'diary_manual'
     AND EXCLUDED.source = 'story_geofence';

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION record_venue_attendance_from_story()
  FROM PUBLIC, anon, authenticated;
