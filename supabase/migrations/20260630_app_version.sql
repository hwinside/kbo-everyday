-- App version share per native platform. The native shells report their
-- binary version+build (Capacitor App.getInfo()) on each page view; we store it
-- on admin_page_views and aggregate distinct active devices per version for the
-- /admin/traffic card. Forward-only: rows before this ships have NULL version
-- ('미상' in the rollup) until each device next opens the app. Web/PWA have no
-- app version (always NULL). service_role only, behind the admin PIN gate.

ALTER TABLE admin_page_views
  ADD COLUMN IF NOT EXISTS app_version text;

CREATE OR REPLACE FUNCTION admin_app_version_share(p_since date)
RETURNS TABLE(platform text, app_version text, devices bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Count each device once, by its *latest* page view in the window. Grouping
  -- raw rows by (platform, app_version) would double-count a device that
  -- updated mid-window or logged a NULL ('미상') row before a versioned one,
  -- inflating the device total and the % denominator.
  WITH latest AS (
    SELECT DISTINCT ON (platform, visitor_id)
           platform, visitor_id, app_version
    FROM admin_page_views
    WHERE platform IN ('ios_native', 'android_native', 'native')
      AND NOT starts_with(path, '/_celeb')
      AND created_at >= ((p_since::text || 'T00:00:00+09:00')::timestamptz)
    ORDER BY platform, visitor_id, created_at DESC
  )
  SELECT platform,
         COALESCE(app_version, '미상')  AS app_version,
         count(*)                       AS devices
  FROM latest
  GROUP BY platform, COALESCE(app_version, '미상')
  ORDER BY platform, devices DESC;
$$;

REVOKE EXECUTE ON FUNCTION admin_app_version_share(date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_app_version_share(date) TO service_role;
