-- Window-distinct UV per platform for the /admin/traffic summary.
-- Summing admin_traffic_daily.uv across days double-counts multi-day visitors
-- (reads like WUV/MAU). This computes true DISTINCT visitors over the whole
-- window per platform. Additive: pairs with admin_traffic_daily (which stays
-- per-day for the chart). service_role only, behind the admin PIN gate.
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
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION admin_traffic_totals(date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_traffic_totals(date) TO service_role;
