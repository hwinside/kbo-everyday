-- App traffic tracking V1: distinguish native app / PWA / web page views.
-- `platform` is nullable & additive — pre-existing rows stay NULL (surfaced as
-- 'unknown' in aggregates so they never pollute the web bucket). Forward rows
-- are tagged by the client tracker (ios_native | android_native | pwa | web).

ALTER TABLE admin_page_views ADD COLUMN IF NOT EXISTS platform text;
CREATE INDEX IF NOT EXISTS idx_apv_platform ON admin_page_views(platform);

-- Daily PV/UV aggregation by platform (KST day boundaries). Read-only over
-- aggregate page-view counts; called server-side via the service role behind
-- the admin PIN gate, so execution is locked to service_role.
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
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

REVOKE EXECUTE ON FUNCTION admin_traffic_daily(date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_traffic_daily(date) TO service_role;
