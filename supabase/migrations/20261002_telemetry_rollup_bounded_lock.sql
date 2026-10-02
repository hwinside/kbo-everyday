-- Retain the raw-write barrier: weakening it permits backdated inserts between
-- the raw-empty check and rollup deletion. Wait at most 500ms for transient
-- ingestion instead of NOWAIT; statement_timeout remains unchanged, no replay.
-- Function-local GUC restores the caller's lock_timeout on exit.
CREATE OR REPLACE FUNCTION admin_telemetry_retention_rollups(p_backup_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET lock_timeout = '500ms'
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_raw_cutoff timestamptz := ((v_now AT TIME ZONE 'Asia/Seoul')::date - 30)::timestamp AT TIME ZONE 'Asia/Seoul';
  v_cutoff date := (v_now AT TIME ZONE 'Asia/Seoul')::date - 365;
  v_backup_at timestamptz;
  v_traffic bigint; v_users bigint; v_slices bigint; v_sessions bigint; v_devices bigint;
  v_deleted jsonb; v_audit bigint;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('admin_telemetry_retention', 0)) THEN
    RAISE EXCEPTION 'retention is already running';
  END IF;
  IF p_backup_ref IS NULL OR p_backup_ref !~ '^supabase-physical:[0-9]+@.+$' THEN
    RAISE EXCEPTION 'fresh physical backup reference required';
  END IF;
  v_backup_at := split_part(p_backup_ref, '@', 2)::timestamptz;
  IF NOT isfinite(v_backup_at) OR v_backup_at < v_now - interval '30 hours'
     OR v_backup_at > v_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'physical backup is not fresh';
  END IF;
  LOCK TABLE admin_page_views, admin_page_dwell IN SHARE ROW EXCLUSIVE MODE;
  -- Never discard rollup evidence while eligible raw is still waiting.
  IF EXISTS (SELECT 1 FROM admin_page_views WHERE created_at < v_raw_cutoff)
     OR EXISTS (SELECT 1 FROM admin_page_dwell WHERE created_at < v_raw_cutoff) THEN
    RAISE EXCEPTION 'raw batches remain; rollup cleanup blocked';
  END IF;
  DELETE FROM admin_traffic_daily_visitors WHERE day_kst < v_cutoff;
  GET DIAGNOSTICS v_traffic = ROW_COUNT;
  DELETE FROM admin_page_view_user_days WHERE day_kst < v_cutoff;
  GET DIAGNOSTICS v_users = ROW_COUNT;
  DELETE FROM admin_dwell_session_slices WHERE day_kst < v_cutoff;
  GET DIAGNOSTICS v_slices = ROW_COUNT;
  DELETE FROM admin_dwell_sessions s WHERE NOT EXISTS (
    SELECT 1 FROM admin_dwell_session_slices x WHERE x.session_id = s.id);
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  DELETE FROM admin_app_version_devices
    WHERE last_seen < v_cutoff::timestamp AT TIME ZONE 'Asia/Seoul';
  GET DIAGNOSTICS v_devices = ROW_COUNT;
  v_deleted := jsonb_build_object('pageViews',0,'pageDwell',0,
    'trafficDailyVisitors',v_traffic,'pageViewUserDays',v_users,
    'dwellSessionSlices',v_slices,'dwellSessions',v_sessions,'appVersionDevices',v_devices);
  INSERT INTO admin_telemetry_retention_runs
    (raw_cutoff,rollup_cutoff,backup_ref,deleted,coverage,phase)
  VALUES (v_raw_cutoff,v_cutoff,p_backup_ref,v_deleted,
    jsonb_build_object('pageViews',0,'userDays',0,'pageDwell',0,'pageDwellSessions',0,'pageDwellDistribution',0),
    'rollup_cleanup') RETURNING id INTO v_audit;
  RETURN jsonb_build_object('auditId',v_audit,'deleted',v_deleted);
END;
$$;
REVOKE EXECUTE ON FUNCTION admin_telemetry_retention_rollups(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_telemetry_retention_rollups(text) TO service_role;
