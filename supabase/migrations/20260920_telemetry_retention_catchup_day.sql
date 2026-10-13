-- One explicitly selected, oldest KST day per transaction. No cron wiring.
-- Requires the optimized preview from 20260918. No rollup deletion.
CREATE OR REPLACE FUNCTION admin_telemetry_retention_catchup_day(
  p_day date,
  p_execute boolean DEFAULT false,
  p_backup_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_start timestamptz := p_day::timestamp AT TIME ZONE 'Asia/Seoul';
  v_end timestamptz := (p_day + 1)::timestamp AT TIME ZONE 'Asia/Seoul';
  v_policy_cutoff timestamptz :=
    ((v_now AT TIME ZONE 'Asia/Seoul')::date - 30)::timestamp AT TIME ZONE 'Asia/Seoul';
  v_backup_at timestamptz;
  v_preview jsonb;
  v_key text;
  v_pages bigint;
  v_dwell bigint;
  v_deleted jsonb;
BEGIN
  IF p_day IS NULL OR NOT isfinite(p_day) OR v_end > v_policy_cutoff THEN
    RAISE EXCEPTION 'catch-up day must be wholly outside the 30-day retention window';
  END IF;
  IF p_execute IS NULL THEN
    RAISE EXCEPTION 'execute must be explicit boolean';
  END IF;
  -- Same lock as the regular retention job. Never race preview against purge.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('admin_telemetry_retention', 0)) THEN
    RAISE EXCEPTION 'retention is already running';
  END IF;
  IF p_execute THEN
    IF p_backup_ref IS NULL OR p_backup_ref !~ '^supabase-physical:[0-9]+@.+$' THEN
      RAISE EXCEPTION 'fresh physical backup reference required';
    END IF;
    v_backup_at := split_part(p_backup_ref, '@', 2)::timestamptz;
    -- Validate against wall-clock time, NOT the synthetic preview date.
    IF NOT isfinite(v_backup_at) OR v_backup_at < v_now - interval '30 hours'
       OR v_backup_at > v_now + interval '5 minutes' THEN
      RAISE EXCEPTION 'physical backup is not fresh';
    END IF;
    LOCK TABLE admin_page_views, admin_page_dwell IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  END IF;
  -- An oldest-first prefix preserves complete daily aggregates and session
  -- ordering. An arbitrary row LIMIT would break all five coverage contracts.
  IF EXISTS (SELECT 1 FROM admin_page_views WHERE created_at < v_start)
     OR EXISTS (SELECT 1 FROM admin_page_dwell WHERE created_at < v_start) THEN
    RAISE EXCEPTION 'process the oldest remaining raw day first';
  END IF;
  -- Reuse the reviewed five-way comparison unchanged. This date only selects
  -- the raw prefix; it is never used for backup freshness or actual policy.
  v_preview := admin_telemetry_retention_preview(
    (p_day + 31)::timestamp AT TIME ZONE 'Asia/Seoul');
  IF (v_preview->>'rawCutoff')::timestamptz IS DISTINCT FROM v_end THEN
    RAISE EXCEPTION 'unexpected preview cutoff';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['pageViews', 'userDays', 'pageDwell',
                               'pageDwellSessions', 'pageDwellDistribution'] LOOP
    IF (v_preview->'coverageMismatches'->>v_key)::bigint IS DISTINCT FROM 0::bigint THEN
      RAISE EXCEPTION 'raw-to-rollup coverage mismatch or missing key: %', v_key;
    END IF;
  END LOOP;
  IF NOT p_execute THEN
    RETURN jsonb_build_object('dryRun', true, 'batchDay', p_day,
      'rollupsDeleted', false, 'preview', v_preview);
  END IF;
  DELETE FROM admin_page_views WHERE created_at >= v_start AND created_at < v_end;
  GET DIAGNOSTICS v_pages = ROW_COUNT;
  DELETE FROM admin_page_dwell WHERE created_at >= v_start AND created_at < v_end;
  GET DIAGNOSTICS v_dwell = ROW_COUNT;
  IF v_pages IS DISTINCT FROM (v_preview #>> '{rawCandidates,pageViews}')::bigint
     OR v_dwell IS DISTINCT FROM (v_preview #>> '{rawCandidates,pageDwell}')::bigint THEN
    RAISE EXCEPTION 'raw delete count mismatch';
  END IF;
  v_deleted := jsonb_build_object('pageViews', v_pages, 'pageDwell', v_dwell,
    'trafficDailyVisitors', 0, 'pageViewUserDays', 0, 'dwellSessionSlices', 0,
    'dwellSessions', 0, 'appVersionDevices', 0);
  -- Empty retry never advances to another day and creates no duplicate audit.
  IF v_pages + v_dwell > 0 THEN
    INSERT INTO admin_telemetry_retention_runs
      (raw_cutoff, rollup_cutoff, backup_ref, deleted, coverage)
    VALUES (v_end, (v_now AT TIME ZONE 'Asia/Seoul')::date - 365,
      p_backup_ref, v_deleted, v_preview->'coverageMismatches');
  END IF;
  RETURN jsonb_build_object('dryRun', false, 'batchDay', p_day,
    'backupRef', p_backup_ref, 'deleted', v_deleted, 'rollupsDeleted', false,
    'preview', v_preview);
END;
$$;
REVOKE EXECUTE ON FUNCTION admin_telemetry_retention_catchup_day(date, boolean, text)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_telemetry_retention_catchup_day(date, boolean, text)
  TO service_role;
