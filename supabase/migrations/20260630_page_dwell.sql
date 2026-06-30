-- Accurate per-page active dwell time (v2 of platform 체류시간).
-- The client measures *foreground active* time on each page (paused while the
-- tab is hidden) and beacons it to /api/telemetry/page-dwell, which inserts
-- here with service_role. Aggregated into sessions (30-min gap) for the
-- /admin/traffic 체류시간 card. service_role only; clients never read/write
-- this table directly (RLS on + zero policies = deny all non-service access).

CREATE TABLE IF NOT EXISTS admin_page_dwell (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  visitor_id  text        NOT NULL,
  user_id     uuid,
  path        text,
  platform    text,
  dwell_ms    integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_dwell_created
  ON admin_page_dwell (created_at);
CREATE INDEX IF NOT EXISTS idx_page_dwell_platform_created
  ON admin_page_dwell (platform, created_at);

ALTER TABLE admin_page_dwell ENABLE ROW LEVEL SECURITY;

-- Per-platform session dwell for the admin traffic card. A session = one
-- visitor's dwell events grouped with a 30-min inactivity gap; session time =
-- sum of active page dwell within it. Reports mean + median (median is the
-- honest central tendency; mean is skewed by long idle-but-visible tails).
CREATE OR REPLACE FUNCTION admin_dwell_by_platform(p_since date)
RETURNS TABLE(platform text, sessions bigint, avg_ms numeric, median_ms numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ev AS (
    SELECT COALESCE(platform, 'unknown') AS platform,
           visitor_id,
           created_at,
           dwell_ms,
           LAG(created_at) OVER (PARTITION BY visitor_id ORDER BY created_at) AS prev
    FROM admin_page_dwell
    WHERE created_at >= ((p_since::text || 'T00:00:00+09:00')::timestamptz)
  ),
  marked AS (
    SELECT *,
           CASE WHEN prev IS NULL OR created_at - prev > interval '30 minutes'
                THEN 1 ELSE 0 END AS new_sess
    FROM ev
  ),
  sess AS (
    SELECT platform, visitor_id, dwell_ms,
           SUM(new_sess) OVER (PARTITION BY visitor_id ORDER BY created_at) AS sess_no
    FROM marked
  ),
  totals AS (
    SELECT platform, visitor_id, sess_no, SUM(dwell_ms) AS sess_ms
    FROM sess
    GROUP BY platform, visitor_id, sess_no
  )
  SELECT platform,
         count(*)                                                          AS sessions,
         round(avg(sess_ms))                                               AS avg_ms,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY sess_ms))       AS median_ms
  FROM totals
  GROUP BY platform
  ORDER BY platform;
$$;

REVOKE EXECUTE ON FUNCTION admin_dwell_by_platform(date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_dwell_by_platform(date) TO service_role;
