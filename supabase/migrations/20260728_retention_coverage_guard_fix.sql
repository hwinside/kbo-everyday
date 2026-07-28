-- Retention coverage guard fix (#dev 2026-07-28).
-- Supersedes the userDays coverage check in 20260722_admin_telemetry_retention.sql
-- (CREATE OR REPLACE, idempotent). No table or run()-function change.
--
-- Root cause of the 07:30 fail-closed block (mismatch = 4, all userDays):
-- 20260727_auth_user_delete_cascades.sql set admin_page_views.user_id to
-- ON DELETE SET NULL. When an account is deleted, its raw page-view rows
-- survive with user_id = NULL, so they drop out of raw_user_days, while the
-- per-user rollup admin_page_view_user_days keeps the aggregate. The FULL JOIN
-- then reported those rollup rows as coverage mismatches on days that are
-- still raw-purge candidates (raw for that calendar day still exists), so
-- purge was blocked forever.
--
-- Fix: a rollup-only user-day (raw side absent) is legitimate ONLY when the
-- account was deleted (user_id absent from auth.users) AND the day's deleted
-- demand EXACTLY reconciles with the non-celeb NULL-user raw page-view pool it
-- was anonymized into -- both the page-view count (deleted_demand = anon_pv)
-- and the game-id set (exact @>/<@). auth.users absence alone is not proof of
-- deletion (arbitrary/corrupt UUIDs satisfy it too), so an under-pool fit
-- (demand < pool) is rejected: a fabricated missing-auth user-day injected
-- within a day's anonymized headroom must NOT be excused. This keeps FAILing
-- (PR #765 blocker):
--   * a rollup-only row whose user still exists (real coverage loss),
--   * fabricated rollup rows whose demand exceeds OR undershoots the pool,
--   * fabricated rows whose game-id set diverges from the anonymized pool,
--   * raw-only rows and value/game-id mismatches (unchanged).
-- The other four coverage checks (pageViews/pageDwell/pageDwellSessions/
-- pageDwellDistribution) are visitor-keyed, not user-keyed: account deletion
-- nulls user_id but keeps visitor_id, so their raw rows still match the rollup
-- and they were never affected. They already exclude out-of-candidate rollup
-- rows via the candidate_days join, so they are left untouched.

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
  v_rollup_cutoff_ts timestamptz :=
    (((v_today_kst - 365)::text || 'T00:00:00+09:00')::timestamptz);
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
  v_app_version_expired bigint;
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
  ), null_user_pool AS (
    -- Anonymized raw page views a deleted account's rollup could have come from,
    -- with the game-id set they touched, for an exact day-level reconciliation.
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst,
           count(*)::bigint AS anon_pv,
           COALESCE(
             array_agg(DISTINCT substring(path FROM '^/games/([0-9]{8}[A-Za-z0-9]+)'))
               FILTER (WHERE substring(path FROM '^/games/([0-9]{8}[A-Za-z0-9]+)') IS NOT NULL),
             '{}'::text[]
           ) AS anon_game_ids
    FROM admin_page_views
    WHERE created_at < v_raw_cutoff
      AND user_id IS NULL
      AND NOT starts_with(path, '/_celeb')
    GROUP BY 1
  ), user_day_mismatch_rows AS (
    SELECT COALESCE(raw.day_kst, rolled.day_kst) AS day_kst,
           (raw.user_id IS NULL) AS rollup_only,
           (
             raw.user_id IS NULL
             AND rolled.user_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM auth.users AS u WHERE u.id = rolled.user_id
             )
           ) AS deleted_account,
           COALESCE(rolled.page_views, 0) AS rolled_page_views,
           COALESCE(rolled.game_ids, '{}'::text[]) AS rolled_game_ids
    FROM raw_user_days AS raw
    FULL JOIN rolled_user_days AS rolled
      USING (day_kst, user_id)
    WHERE rolled.page_views IS DISTINCT FROM raw.page_views
       OR raw.game_ids IS NULL
       OR rolled.game_ids IS NULL
       OR NOT (
         rolled.game_ids @> raw.game_ids
         AND rolled.game_ids <@ raw.game_ids
       )
  ), deleted_demand_by_day AS (
    -- Aggregate the whole day's deleted-account rollup demand and game-id set
    -- so it can be exact-matched against the anonymized NULL-user raw pool.
    SELECT rows.day_kst,
           sum(rows.rolled_page_views)::bigint AS deleted_demand,
           COALESCE(
             array_agg(DISTINCT game_id) FILTER (WHERE game_id IS NOT NULL),
             '{}'::text[]
           ) AS deleted_game_ids
    FROM user_day_mismatch_rows AS rows
    LEFT JOIN LATERAL unnest(rows.rolled_game_ids) AS game_id ON true
    WHERE rows.deleted_account
    GROUP BY rows.day_kst
  ), user_day_classified AS (
    SELECT rows.day_kst,
           rows.rollup_only,
           rows.deleted_account,
           COALESCE(demand.deleted_demand, 0) AS deleted_demand,
           COALESCE(demand.deleted_game_ids, '{}'::text[]) AS deleted_game_ids,
           COALESCE(pool.anon_pv, 0) AS anon_pv,
           COALESCE(pool.anon_game_ids, '{}'::text[]) AS anon_game_ids
    FROM user_day_mismatch_rows AS rows
    LEFT JOIN deleted_demand_by_day AS demand USING (day_kst)
    LEFT JOIN null_user_pool AS pool USING (day_kst)
  )
  SELECT count(*) INTO v_user_day_mismatches
  FROM user_day_classified
  WHERE NOT (
    -- Exclude only EXACTLY-reconciled deleted-account rollup rows: the whole
    -- day's deleted demand must equal its anonymized raw pool on both the
    -- page-view count AND the game-id set. auth.users absence is not deletion
    -- proof, so an under-pool fit (demand < pool) leaves every such row as a
    -- mismatch (fail-closed) rather than excusing headroom-sized fabrications.
    rollup_only
    AND deleted_account
    AND deleted_demand = anon_pv
    AND deleted_game_ids @> anon_game_ids
    AND deleted_game_ids <@ anon_game_ids
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
  SELECT count(*) INTO v_app_version_expired
  FROM admin_app_version_devices WHERE last_seen < v_rollup_cutoff_ts;

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
      'dwellSessionSlices', v_dwell_slices_expired,
      'appVersionDevices', v_app_version_expired
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_telemetry_retention_preview(timestamptz)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_telemetry_retention_preview(timestamptz) TO service_role;
