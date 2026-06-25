-- Fix traffic collection: real client page views never landed.
--
-- admin_page_views has RLS ENABLED but ZERO policies, so client-side
-- trackPageView() inserts (role: authenticated) were always denied — the only
-- rows that landed were server-side service_role celebration telemetry
-- (synthetic '/_celeb/...' paths), which bypasses RLS. Result: every "page
-- view" in the table is celebration telemetry and platform is always NULL.
--
-- (1) Add an INSERT policy so logged-in page views are actually recorded,
--     scoped to the caller's own user_id to prevent attribution spoofing.
-- (2) Exclude the '/_celeb/' synthetic telemetry paths from the traffic
--     aggregates so the dashboard counts real visits only.

-- (1) Allow authenticated users to record their own page views.
DROP POLICY IF EXISTS "apv_insert_own" ON admin_page_views;
CREATE POLICY "apv_insert_own" ON admin_page_views
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- (2) Exclude celebration telemetry from traffic aggregates.
CREATE OR REPLACE FUNCTION admin_traffic_daily(p_since date)
RETURNS TABLE(day date, platform text, pv bigint, uv bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
         COALESCE(platform, 'unknown')                AS platform,
         count(*)                                     AS pv,
         count(DISTINCT visitor_id)                   AS uv
  FROM admin_page_views
  WHERE created_at >= ((p_since::text || 'T00:00:00+09:00')::timestamptz)
    AND NOT starts_with(path, '/_celeb')
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

CREATE OR REPLACE FUNCTION admin_traffic_totals(p_since date)
RETURNS TABLE(platform text, pv bigint, uv bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(platform, 'unknown')  AS platform,
         count(*)                        AS pv,
         count(DISTINCT visitor_id)      AS uv
  FROM admin_page_views
  WHERE created_at >= ((p_since::text || 'T00:00:00+09:00')::timestamptz)
    AND NOT starts_with(path, '/_celeb')
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION admin_traffic_daily(date) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_traffic_totals(date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_traffic_daily(date) TO service_role;
GRANT EXECUTE ON FUNCTION admin_traffic_totals(date) TO service_role;
