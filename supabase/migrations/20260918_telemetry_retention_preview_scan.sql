-- Bound retention preview work to one scan per eligible raw set.
-- No timeout increase, retention-policy change, or weakening of coverage checks.
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
  -- Read each eligible raw set once. Keep all five independent fail-closed
  -- comparisons; raw dwell sessions are still reconstructed without rollup input.
  WITH page_candidates AS MATERIALIZED (
    SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst,
           platform, visitor_id, user_id, starts_with(path, '/_celeb') AS is_celeb,
           CASE WHEN path LIKE '/games/%'
             THEN substring(path FROM '^/games/([0-9]{8}[A-Za-z0-9]+)')
           END AS game_id
    FROM admin_page_views WHERE created_at < v_raw_cutoff
  ), dwell_candidates AS MATERIALIZED (
    SELECT id, created_at, (created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst,
           platform, visitor_id, dwell_ms
    FROM admin_page_dwell WHERE created_at < v_raw_cutoff
  ), page_candidate_days AS MATERIALIZED (
    SELECT DISTINCT day_kst
    FROM page_candidates
  ), page_raw_daily AS (
    SELECT day_kst,
           COALESCE(platform, 'unknown') AS platform,
           visitor_id,
           count(*)::bigint AS pv
    FROM page_candidates
    WHERE NOT is_celeb
    GROUP BY 1, 2, 3
  ), page_rolled_daily AS (
    SELECT rolled.day_kst, rolled.platform, rolled.visitor_id, rolled.pv
    FROM admin_traffic_daily_visitors AS rolled
    JOIN page_candidate_days AS candidates USING (day_kst)
  ), user_raw_user_days AS (
    SELECT day_kst,
           user_id,
           count(*)::bigint AS page_views,
           COALESCE(
             array_agg(DISTINCT game_id)
               FILTER (WHERE game_id IS NOT NULL),
             '{}'::text[]
           ) AS game_ids
    FROM page_candidates
    WHERE user_id IS NOT NULL
      AND NOT is_celeb
    GROUP BY 1, 2
  ), user_rolled_user_days AS (
    SELECT rolled.day_kst,
           rolled.user_id,
           rolled.page_views,
           rolled.game_ids
    FROM admin_page_view_user_days AS rolled
    JOIN page_candidate_days AS candidates USING (day_kst)
  ), user_null_user_pool AS (
    -- Anonymized raw page views a deleted account's rollup could have come from,
    -- with the game-id set they touched, for an exact day-level reconciliation.
    SELECT day_kst,
           count(*)::bigint AS anon_pv,
           COALESCE(
             array_agg(DISTINCT game_id)
               FILTER (WHERE game_id IS NOT NULL),
             '{}'::text[]
           ) AS anon_game_ids
    FROM page_candidates
    WHERE user_id IS NULL
      AND NOT is_celeb
    GROUP BY 1
  ), user_user_day_mismatch_rows AS (
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
    FROM user_raw_user_days AS raw
    FULL JOIN user_rolled_user_days AS rolled
      USING (day_kst, user_id)
    WHERE rolled.page_views IS DISTINCT FROM raw.page_views
       OR raw.game_ids IS NULL
       OR rolled.game_ids IS NULL
       OR NOT (
         rolled.game_ids @> raw.game_ids
         AND rolled.game_ids <@ raw.game_ids
       )
  ), user_deleted_demand_pv AS (
    -- Whole-day deleted-account page-view demand, summed once per user-day.
    -- Kept separate from the game-id set aggregation below: fanning the rows
    -- out over their game-ids (unnest) before summing page_views would
    -- multiply the demand by each row's game-id count (a 2-game user-day would
    -- report double its page views), mismatching the anonymized pool and
    -- permanently blocking purge for legitimate multi-game deletions.
    SELECT rows.day_kst,
           sum(rows.rolled_page_views)::bigint AS deleted_demand
    FROM user_user_day_mismatch_rows AS rows
    WHERE rows.deleted_account
    GROUP BY rows.day_kst
  ), user_deleted_demand_games AS (
    -- The distinct game-id set the day's deleted-account rollups touched,
    -- aggregated independently of the page-view demand above.
    SELECT rows.day_kst,
           COALESCE(
             array_agg(DISTINCT game_id) FILTER (WHERE game_id IS NOT NULL),
             '{}'::text[]
           ) AS deleted_game_ids
    FROM user_user_day_mismatch_rows AS rows
    LEFT JOIN LATERAL unnest(rows.rolled_game_ids) AS game_id ON true
    WHERE rows.deleted_account
    GROUP BY rows.day_kst
  ), user_user_day_classified AS (
    SELECT rows.day_kst,
           rows.rollup_only,
           rows.deleted_account,
           COALESCE(demand.deleted_demand, 0) AS deleted_demand,
           COALESCE(games.deleted_game_ids, '{}'::text[]) AS deleted_game_ids,
           COALESCE(pool.anon_pv, 0) AS anon_pv,
           COALESCE(pool.anon_game_ids, '{}'::text[]) AS anon_game_ids
    FROM user_user_day_mismatch_rows AS rows
    LEFT JOIN user_deleted_demand_pv AS demand USING (day_kst)
    LEFT JOIN user_deleted_demand_games AS games USING (day_kst)
    LEFT JOIN user_null_user_pool AS pool USING (day_kst)
  ), dwell_raw_dwell AS (
    SELECT day_kst,
           COALESCE(platform, 'unknown') AS platform,
           sum(dwell_ms)::bigint AS dwell_ms,
           count(*)::bigint AS events
    FROM dwell_candidates
    GROUP BY 1, 2
  ), dwell_rolled_dwell AS (
    SELECT day_kst,
           platform,
           sum(dwell_ms)::bigint AS dwell_ms,
           sum(event_count)::bigint AS events
    FROM admin_dwell_session_slices
    WHERE day_kst < (v_raw_cutoff AT TIME ZONE 'Asia/Seoul')::date
    GROUP BY 1, 2
  ), session_candidate_days AS MATERIALIZED (
    SELECT DISTINCT day_kst
    FROM dwell_candidates
  -- Inline the single-use window pipeline so PostgreSQL can preserve its
  -- visitor/time ordering instead of materializing and sorting every stage.
  ), session_raw_ordered AS NOT MATERIALIZED (
    SELECT id, day_kst,
           visitor_id,
           COALESCE(platform, 'unknown') AS platform,
           created_at,
           dwell_ms,
           lag(created_at) OVER (
             PARTITION BY visitor_id
             ORDER BY created_at, id
           ) AS previous_at
    FROM dwell_candidates
  ), session_raw_marked AS NOT MATERIALIZED (
    SELECT *,
           CASE
             WHEN previous_at IS NULL
               OR created_at - previous_at > interval '30 minutes'
             THEN 1 ELSE 0
           END AS new_session
    FROM session_raw_ordered
  ), session_raw_sessionized AS NOT MATERIALIZED (
    SELECT *,
           sum(new_session) OVER (
             PARTITION BY visitor_id
             ORDER BY created_at, id
             ROWS UNBOUNDED PRECEDING
           ) AS session_no
    FROM session_raw_marked
  ), session_raw_session_slices AS MATERIALIZED (
    SELECT visitor_id,
           session_no,
           platform,
           day_kst,
           sum(dwell_ms)::bigint AS dwell_ms,
           count(*)::bigint AS events
    FROM session_raw_sessionized
    GROUP BY 1, 2, 3, 4
  ), session_candidate_slices AS MATERIALIZED (
    SELECT rolled.session_id, rolled.platform, rolled.day_kst,
           rolled.dwell_ms, rolled.event_count
    FROM admin_dwell_session_slices AS rolled
    JOIN session_candidate_days AS candidates USING (day_kst)
  ), session_rolled_candidate_sessions AS NOT MATERIALIZED (
    SELECT sessions.id AS session_id,
           sessions.visitor_id,
           sessions.session_start
    FROM admin_dwell_sessions AS sessions
    JOIN (SELECT DISTINCT session_id FROM session_candidate_slices) AS candidates
      ON candidates.session_id = sessions.id
  ), session_rolled_sessionized AS NOT MATERIALIZED (
    SELECT session_id,
           visitor_id,
           row_number() OVER (
             PARTITION BY visitor_id
             ORDER BY session_start, session_id
           ) AS session_no
    FROM session_rolled_candidate_sessions
  ), session_rolled_session_slices AS MATERIALIZED (
    SELECT sessions.visitor_id,
           sessions.session_no,
           rolled.platform,
           rolled.day_kst,
           rolled.dwell_ms,
           rolled.event_count::bigint AS events
    FROM session_rolled_sessionized AS sessions
    JOIN session_candidate_slices AS rolled
      ON rolled.session_id = sessions.session_id
  ), session_distribution_mismatches AS (
    SELECT 1
    FROM session_raw_session_slices AS raw
    FULL JOIN session_rolled_session_slices AS rolled
      USING (visitor_id, session_no, platform, day_kst)
    WHERE rolled.dwell_ms IS DISTINCT FROM raw.dwell_ms
       OR rolled.events IS DISTINCT FROM raw.events
  -- De-duplicate scalar keys before counting: same session/platform contract,
  -- without composite-record DISTINCT comparisons.
  ), session_raw_platform_counts AS (
    SELECT platform,
           count(*)::bigint AS sessions
    FROM (SELECT DISTINCT platform, visitor_id, session_no
          FROM session_raw_session_slices) AS distinct_sessions
    GROUP BY platform
  ), session_rolled_platform_counts AS (
    SELECT platform,
           count(*)::bigint AS sessions
    FROM (SELECT DISTINCT platform, visitor_id, session_no
          FROM session_rolled_session_slices) AS distinct_sessions
    GROUP BY platform
  ), session_platform_count_mismatches AS (
    SELECT 1
    FROM session_raw_platform_counts AS raw
    FULL JOIN session_rolled_platform_counts AS rolled USING (platform)
    WHERE rolled.sessions IS DISTINCT FROM raw.sessions
  )
  SELECT (SELECT count(*) FROM page_candidates),
         (SELECT count(*) FROM dwell_candidates),
         (SELECT count(*)
  FROM page_raw_daily AS raw
  FULL JOIN page_rolled_daily AS rolled
    USING (day_kst, platform, visitor_id)
  WHERE rolled.pv IS DISTINCT FROM raw.pv),
         (SELECT count(*)
  FROM user_user_day_classified
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
  )),
         (SELECT count(*)
  FROM dwell_raw_dwell AS raw
  LEFT JOIN dwell_rolled_dwell AS rolled USING (day_kst, platform)
  WHERE rolled.events IS DISTINCT FROM raw.events
     OR rolled.dwell_ms IS DISTINCT FROM raw.dwell_ms),
         (SELECT count(*) FROM session_platform_count_mismatches),
         (SELECT count(*) FROM session_distribution_mismatches)
  INTO v_page_candidates, v_dwell_candidates,
       v_page_mismatches, v_user_day_mismatches, v_dwell_mismatches,
       v_dwell_session_count_mismatches, v_dwell_distribution_mismatches;

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
