-- Admin telemetry retention (#dev 2026-07-22).
-- Dependency: 20260721_admin_traffic_{dwell,page_view}_rollup.sql (PR #753).
--
-- Raw admin_page_views/admin_page_dwell: 30 complete KST calendar days.
-- Incremental rollups: 365 complete KST calendar days.
-- DELETE is fail-closed behind physical-backup and exact coverage gates.

CREATE TABLE admin_page_view_user_days (
  day_kst    date   NOT NULL,
  user_id    uuid   NOT NULL,
  page_views bigint NOT NULL CHECK (page_views > 0),
  game_ids   text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (day_kst, user_id)
);

CREATE TABLE admin_telemetry_retention_runs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at         timestamptz NOT NULL DEFAULT now(),
  raw_cutoff     timestamptz NOT NULL,
  rollup_cutoff  date NOT NULL,
  backup_ref     text NOT NULL,
  deleted        jsonb NOT NULL,
  coverage       jsonb NOT NULL
);

ALTER TABLE admin_page_view_user_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_telemetry_retention_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_admin_page_view_user_days_user_day
  ON admin_page_view_user_days (user_id, day_kst);

-- Close the backfill/trigger handoff gap.
LOCK TABLE admin_page_views IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO admin_page_view_user_days (day_kst, user_id, page_views, game_ids)
SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date,
       user_id,
       count(*)::bigint,
       COALESCE(
         array_agg(DISTINCT substring(path FROM '^/games/([0-9]{8}[A-Za-z0-9]+)'))
           FILTER (WHERE substring(path FROM '^/games/([0-9]{8}[A-Za-z0-9]+)') IS NOT NULL),
         '{}'::text[]
       )
FROM admin_page_views
WHERE user_id IS NOT NULL
  AND NOT starts_with(path, '/_celeb')
GROUP BY 1, 2;

CREATE OR REPLACE FUNCTION admin_page_views_track_user_day()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game_id text := substring(NEW.path FROM '^/games/([0-9]{8}[A-Za-z0-9]+)');
BEGIN
  IF NEW.user_id IS NULL OR starts_with(NEW.path, '/_celeb') THEN
    RETURN NEW;
  END IF;

  INSERT INTO admin_page_view_user_days (day_kst, user_id, page_views, game_ids)
  VALUES (
    (NEW.created_at AT TIME ZONE 'Asia/Seoul')::date,
    NEW.user_id,
    1,
    CASE WHEN v_game_id IS NULL THEN '{}'::text[] ELSE ARRAY[v_game_id] END
  )
  ON CONFLICT (day_kst, user_id) DO UPDATE
  SET page_views = admin_page_view_user_days.page_views + 1,
      game_ids = CASE
        WHEN v_game_id IS NULL OR v_game_id = ANY(admin_page_view_user_days.game_ids)
          THEN admin_page_view_user_days.game_ids
        ELSE array_append(admin_page_view_user_days.game_ids, v_game_id)
      END;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_page_views_track_user_day()
  FROM public, anon, authenticated;

CREATE TRIGGER trg_admin_page_views_track_user_day
  AFTER INSERT ON admin_page_views
  FOR EACH ROW EXECUTE FUNCTION admin_page_views_track_user_day();

CREATE OR REPLACE FUNCTION admin_telemetry_retention_preview(
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today_kst date := (p_now AT TIME ZONE 'Asia/Seoul')::date;
  v_raw_cutoff timestamptz := (((v_today_kst - 30)::text || 'T00:00:00+09:00')::timestamptz);
  v_rollup_cutoff date := v_today_kst - 365;
  v_page_candidates bigint;
  v_dwell_candidates bigint;
  v_page_mismatches bigint;
  v_user_day_mismatches bigint;
  v_dwell_mismatches bigint;
  v_dwell_session_count_mismatches bigint;
  v_dwell_distribution_mismatches bigint;
  v_traffic_expired bigint;
  v_user_days_expired bigint;
  v_dwell_slices_expired bigint;
BEGIN
  SELECT count(*) INTO v_page_candidates
  FROM admin_page_views
  WHERE created_at < v_raw_cutoff;

  SELECT count(*) INTO v_dwell_candidates
  FROM admin_page_dwell
  WHERE created_at < v_raw_cutoff;

  WITH candidate_days AS MATERIALIZED (
    SELECT DISTINCT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst
    FROM admin_page_views
    WHERE created_at < v_raw_cutoff
  ), raw_daily AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst,
           COALESCE(platform, 'unknown') AS platform,
           visitor_id,
           count(*)::bigint AS pv
    FROM admin_page_views
    WHERE created_at < v_raw_cutoff
      AND NOT starts_with(path, '/_celeb')
    GROUP BY 1, 2, 3
  ), rolled_daily AS (
    SELECT rolled.day_kst, rolled.platform, rolled.visitor_id, rolled.pv
    FROM admin_traffic_daily_visitors AS rolled
    JOIN candidate_days AS candidates USING (day_kst)
  )
  SELECT count(*) INTO v_page_mismatches
  FROM raw_daily AS raw
  FULL JOIN rolled_daily AS rolled
    USING (day_kst, platform, visitor_id)
  WHERE rolled.pv IS DISTINCT FROM raw.pv;

  WITH candidate_days AS MATERIALIZED (
    SELECT DISTINCT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst
    FROM admin_page_views
    WHERE created_at < v_raw_cutoff
  ), raw_user_days AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst,
           user_id,
           count(*)::bigint AS page_views,
           COALESCE(
             array_agg(DISTINCT substring(path FROM '^/games/([0-9]{8}[A-Za-z0-9]+)'))
               FILTER (WHERE substring(path FROM '^/games/([0-9]{8}[A-Za-z0-9]+)') IS NOT NULL),
             '{}'::text[]
           ) AS game_ids
    FROM admin_page_views
    WHERE created_at < v_raw_cutoff
      AND user_id IS NOT NULL
      AND NOT starts_with(path, '/_celeb')
    GROUP BY 1, 2
  ), rolled_user_days AS (
    SELECT rolled.day_kst,
           rolled.user_id,
           rolled.page_views,
           rolled.game_ids
    FROM admin_page_view_user_days AS rolled
    JOIN candidate_days AS candidates USING (day_kst)
  )
  SELECT count(*) INTO v_user_day_mismatches
  FROM raw_user_days AS raw
  FULL JOIN rolled_user_days AS rolled
    USING (day_kst, user_id)
  WHERE rolled.page_views IS DISTINCT FROM raw.page_views
     OR raw.game_ids IS NULL
     OR rolled.game_ids IS NULL
     OR NOT (
       rolled.game_ids @> raw.game_ids
       AND rolled.game_ids <@ raw.game_ids
     );

  WITH raw_dwell AS (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst,
           COALESCE(platform, 'unknown') AS platform,
           sum(dwell_ms)::bigint AS dwell_ms,
           count(*)::bigint AS events
    FROM admin_page_dwell
    WHERE created_at < v_raw_cutoff
    GROUP BY 1, 2
  ), rolled_dwell AS (
    SELECT day_kst,
           platform,
           sum(dwell_ms)::bigint AS dwell_ms,
           sum(event_count)::bigint AS events
    FROM admin_dwell_session_slices
    WHERE day_kst < (v_raw_cutoff AT TIME ZONE 'Asia/Seoul')::date
    GROUP BY 1, 2
  )
  SELECT count(*) INTO v_dwell_mismatches
  FROM raw_dwell AS raw
  LEFT JOIN rolled_dwell AS rolled USING (day_kst, platform)
  WHERE rolled.events IS DISTINCT FROM raw.events
     OR rolled.dwell_ms IS DISTINCT FROM raw.dwell_ms;

  -- Rebuild raw sessions independently from the visitor-wide 30-minute gap.
  -- The rollup's session boundaries are data under validation and must never
  -- define the raw side: corrupting 2 raw sessions into 1 rollup session would
  -- otherwise make the validator reproduce the same corruption.
  --
  -- Compare exact session/day/platform slices after independently numbering
  -- raw and rollup sessions per visitor. This preserves both the within-day
  -- distribution and the attachment of slices across reporting-window days.
  WITH candidate_days AS MATERIALIZED (
    SELECT DISTINCT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst
    FROM admin_page_dwell
    WHERE created_at < v_raw_cutoff
  ), raw_ordered AS MATERIALIZED (
    SELECT id,
           visitor_id,
           COALESCE(platform, 'unknown') AS platform,
           created_at,
           dwell_ms,
           lag(created_at) OVER (
             PARTITION BY visitor_id
             ORDER BY created_at, id
           ) AS previous_at
    FROM admin_page_dwell
    WHERE created_at < v_raw_cutoff
  ), raw_marked AS MATERIALIZED (
    SELECT *,
           CASE
             WHEN previous_at IS NULL
               OR created_at - previous_at > interval '30 minutes'
             THEN 1 ELSE 0
           END AS new_session
    FROM raw_ordered
  ), raw_sessionized AS MATERIALIZED (
    SELECT *,
           sum(new_session) OVER (
             PARTITION BY visitor_id
             ORDER BY created_at, id
             ROWS UNBOUNDED PRECEDING
           ) AS session_no
    FROM raw_marked
  ), raw_session_slices AS MATERIALIZED (
    SELECT visitor_id,
           session_no,
           platform,
           (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst,
           sum(dwell_ms)::bigint AS dwell_ms,
           count(*)::bigint AS events
    FROM raw_sessionized
    GROUP BY 1, 2, 3, 4
  ), rolled_candidate_sessions AS MATERIALIZED (
    SELECT sessions.id AS session_id,
           sessions.visitor_id,
           sessions.session_start
    FROM admin_dwell_sessions AS sessions
    JOIN admin_dwell_session_slices AS rolled
      ON rolled.session_id = sessions.id
    JOIN candidate_days AS candidates USING (day_kst)
    GROUP BY sessions.id, sessions.visitor_id, sessions.session_start
  ), rolled_sessionized AS MATERIALIZED (
    SELECT session_id,
           visitor_id,
           row_number() OVER (
             PARTITION BY visitor_id
             ORDER BY session_start, session_id
           ) AS session_no
    FROM rolled_candidate_sessions
  ), rolled_session_slices AS MATERIALIZED (
    SELECT sessions.visitor_id,
           sessions.session_no,
           rolled.platform,
           rolled.day_kst,
           rolled.dwell_ms,
           rolled.event_count::bigint AS events
    FROM rolled_sessionized AS sessions
    JOIN admin_dwell_session_slices AS rolled
      ON rolled.session_id = sessions.session_id
    JOIN candidate_days AS candidates USING (day_kst)
  ), distribution_mismatches AS (
    SELECT 1
    FROM raw_session_slices AS raw
    FULL JOIN rolled_session_slices AS rolled
      USING (visitor_id, session_no, platform, day_kst)
    WHERE rolled.dwell_ms IS DISTINCT FROM raw.dwell_ms
       OR rolled.events IS DISTINCT FROM raw.events
  ), raw_platform_counts AS (
    SELECT platform,
           count(DISTINCT (visitor_id, session_no))::bigint AS sessions
    FROM raw_session_slices
    GROUP BY platform
  ), rolled_platform_counts AS (
    SELECT platform,
           count(DISTINCT (visitor_id, session_no))::bigint AS sessions
    FROM rolled_session_slices
    GROUP BY platform
  ), platform_count_mismatches AS (
    SELECT 1
    FROM raw_platform_counts AS raw
    FULL JOIN rolled_platform_counts AS rolled USING (platform)
    WHERE rolled.sessions IS DISTINCT FROM raw.sessions
  )
  SELECT (SELECT count(*) FROM platform_count_mismatches),
         (SELECT count(*) FROM distribution_mismatches)
  INTO v_dwell_session_count_mismatches,
       v_dwell_distribution_mismatches;

  SELECT count(*) INTO v_traffic_expired
  FROM admin_traffic_daily_visitors WHERE day_kst < v_rollup_cutoff;
  SELECT count(*) INTO v_user_days_expired
  FROM admin_page_view_user_days WHERE day_kst < v_rollup_cutoff;
  SELECT count(*) INTO v_dwell_slices_expired
  FROM admin_dwell_session_slices WHERE day_kst < v_rollup_cutoff;

  RETURN jsonb_build_object(
    'rawCutoff', v_raw_cutoff,
    'rollupCutoff', v_rollup_cutoff,
    'rawCandidates', jsonb_build_object(
      'pageViews', v_page_candidates,
      'pageDwell', v_dwell_candidates
    ),
    'coverageMismatches', jsonb_build_object(
      'pageViews', v_page_mismatches,
      'userDays', v_user_day_mismatches,
      'pageDwell', v_dwell_mismatches,
      'pageDwellSessions', v_dwell_session_count_mismatches,
      'pageDwellDistribution', v_dwell_distribution_mismatches
    ),
    'expiredRollups', jsonb_build_object(
      'trafficDailyVisitors', v_traffic_expired,
      'pageViewUserDays', v_user_days_expired,
      'dwellSessionSlices', v_dwell_slices_expired
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin_telemetry_retention_run(
  p_execute boolean DEFAULT false,
  p_backup_ref text DEFAULT NULL,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_preview jsonb;
  v_raw_cutoff timestamptz;
  v_rollup_cutoff date;
  v_backup_at timestamptz;
  v_page_candidates bigint;
  v_dwell_candidates bigint;
  v_deleted_page_views bigint := 0;
  v_deleted_page_dwell bigint := 0;
  v_deleted_traffic_rollups bigint := 0;
  v_deleted_user_day_rollups bigint := 0;
  v_deleted_dwell_slices bigint := 0;
  v_deleted_dwell_sessions bigint := 0;
  v_deleted jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_telemetry_retention', 0));

  IF p_execute THEN
    -- Prevent insert/delete drift between coverage snapshot and DELETE counts.
    LOCK TABLE admin_page_views, admin_page_dwell IN SHARE ROW EXCLUSIVE MODE;
  END IF;

  v_preview := admin_telemetry_retention_preview(p_now);
  IF NOT p_execute THEN
    RETURN jsonb_build_object('dryRun', true) || v_preview;
  END IF;

  IF p_backup_ref IS NULL
     OR p_backup_ref !~ '^supabase-physical:[0-9]+@.+$' THEN
    RAISE EXCEPTION 'fresh physical backup reference required';
  END IF;

  BEGIN
    v_backup_at := split_part(p_backup_ref, '@', 2)::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid physical backup timestamp';
  END;
  IF v_backup_at < p_now - interval '30 hours' OR v_backup_at > p_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'physical backup is not fresh';
  END IF;

  IF COALESCE((v_preview #>> '{coverageMismatches,pageViews}')::bigint, 0) <> 0
     OR COALESCE((v_preview #>> '{coverageMismatches,userDays}')::bigint, 0) <> 0
     OR COALESCE((v_preview #>> '{coverageMismatches,pageDwell}')::bigint, 0) <> 0
     OR COALESCE((v_preview #>> '{coverageMismatches,pageDwellSessions}')::bigint, 0) <> 0
     OR COALESCE((v_preview #>> '{coverageMismatches,pageDwellDistribution}')::bigint, 0) <> 0 THEN
    RAISE EXCEPTION 'raw-to-rollup coverage mismatch: %', v_preview->'coverageMismatches';
  END IF;

  v_raw_cutoff := (v_preview->>'rawCutoff')::timestamptz;
  v_rollup_cutoff := (v_preview->>'rollupCutoff')::date;
  v_page_candidates := (v_preview #>> '{rawCandidates,pageViews}')::bigint;
  v_dwell_candidates := (v_preview #>> '{rawCandidates,pageDwell}')::bigint;

  DELETE FROM admin_page_views WHERE created_at < v_raw_cutoff;
  GET DIAGNOSTICS v_deleted_page_views = ROW_COUNT;
  DELETE FROM admin_page_dwell WHERE created_at < v_raw_cutoff;
  GET DIAGNOSTICS v_deleted_page_dwell = ROW_COUNT;

  IF v_deleted_page_views <> v_page_candidates
     OR v_deleted_page_dwell <> v_dwell_candidates THEN
    RAISE EXCEPTION 'raw delete count mismatch: page %/%, dwell %/%',
      v_deleted_page_views, v_page_candidates, v_deleted_page_dwell, v_dwell_candidates;
  END IF;

  DELETE FROM admin_traffic_daily_visitors WHERE day_kst < v_rollup_cutoff;
  GET DIAGNOSTICS v_deleted_traffic_rollups = ROW_COUNT;
  DELETE FROM admin_page_view_user_days WHERE day_kst < v_rollup_cutoff;
  GET DIAGNOSTICS v_deleted_user_day_rollups = ROW_COUNT;
  DELETE FROM admin_dwell_session_slices WHERE day_kst < v_rollup_cutoff;
  GET DIAGNOSTICS v_deleted_dwell_slices = ROW_COUNT;
  DELETE FROM admin_dwell_sessions AS sessions
  WHERE NOT EXISTS (
    SELECT 1 FROM admin_dwell_session_slices AS slices
    WHERE slices.session_id = sessions.id
  );
  GET DIAGNOSTICS v_deleted_dwell_sessions = ROW_COUNT;

  v_deleted := jsonb_build_object(
    'pageViews', v_deleted_page_views,
    'pageDwell', v_deleted_page_dwell,
    'trafficDailyVisitors', v_deleted_traffic_rollups,
    'pageViewUserDays', v_deleted_user_day_rollups,
    'dwellSessionSlices', v_deleted_dwell_slices,
    'dwellSessions', v_deleted_dwell_sessions
  );

  INSERT INTO admin_telemetry_retention_runs (
    raw_cutoff, rollup_cutoff, backup_ref, deleted, coverage
  ) VALUES (
    v_raw_cutoff,
    v_rollup_cutoff,
    p_backup_ref,
    v_deleted,
    v_preview->'coverageMismatches'
  );

  RETURN jsonb_build_object('dryRun', false, 'backupRef', p_backup_ref, 'deleted', v_deleted) || v_preview;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_telemetry_retention_preview(timestamptz)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_telemetry_retention_run(boolean, text, timestamptz)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_telemetry_retention_preview(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION admin_telemetry_retention_run(boolean, text, timestamptz) TO service_role;

ANALYZE admin_page_view_user_days;
