-- Cumulative unique app devices: distinct visitor_id seen from the native app
-- shells (a proxy for installed+opened+logged-in devices, NOT store downloads).
-- All-time, celebration telemetry excluded. service_role only (admin read).

CREATE OR REPLACE FUNCTION admin_app_device_totals()
RETURNS TABLE(platform text, devices bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT platform, count(DISTINCT visitor_id) AS devices
  FROM admin_page_views
  WHERE platform IN ('ios_native', 'android_native', 'native')
    AND NOT starts_with(path, '/_celeb')
  GROUP BY platform
  ORDER BY platform;
$$;

REVOKE EXECUTE ON FUNCTION admin_app_device_totals() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_app_device_totals() TO service_role;
