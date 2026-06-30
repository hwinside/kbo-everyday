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
  SELECT platform,
         COALESCE(app_version, '미상')        AS app_version,
         count(DISTINCT visitor_id)           AS devices
  FROM admin_page_views
  WHERE platform IN ('ios_native', 'android_native', 'native')
    AND NOT starts_with(path, '/_celeb')
    AND created_at >= ((p_since::text || 'T00:00:00+09:00')::timestamptz)
  GROUP BY platform, COALESCE(app_version, '미상')
  ORDER BY platform, devices DESC;
$$;

REVOKE EXECUTE ON FUNCTION admin_app_version_share(date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_app_version_share(date) TO service_role;
