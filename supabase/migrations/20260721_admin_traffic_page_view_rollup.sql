-- The traffic API launches daily, window-total, and app-version aggregates in
-- parallel. Each previously scanned the same ~475k raw page views, so a cold
-- 30-day request could push all three past the 8s statement timeout together.
-- Keep compact, incrementally maintained read models instead.

CREATE TABLE admin_traffic_daily_visitors (
  day_kst    date   NOT NULL,
  platform   text   NOT NULL,
  visitor_id text   NOT NULL,
  pv         bigint NOT NULL CHECK (pv > 0),
  PRIMARY KEY (day_kst, platform, visitor_id)
);

CREATE TABLE admin_app_version_devices (
  platform    text        NOT NULL,
  visitor_id  text        NOT NULL,
  app_version text,
  last_seen   timestamptz NOT NULL,
  PRIMARY KEY (platform, visitor_id)
);

ALTER TABLE admin_traffic_daily_visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_app_version_devices ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_admin_traffic_daily_visitors_day_covering
  ON admin_traffic_daily_visitors (day_kst)
  INCLUDE (platform, visitor_id, pv);

CREATE INDEX idx_admin_app_version_devices_seen_covering
  ON admin_app_version_devices (last_seen)
  INCLUDE (platform, visitor_id, app_version);

-- Close the snapshot/trigger handoff gap. Writers resume after commit with
-- both read models and both triggers present.
LOCK TABLE admin_page_views IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO admin_traffic_daily_visitors (day_kst, platform, visitor_id, pv)
SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date,
       COALESCE(platform, 'unknown'),
       visitor_id,
       count(*)::bigint
FROM admin_page_views
WHERE NOT starts_with(path, '/_celeb')
GROUP BY 1, 2, 3;

INSERT INTO admin_app_version_devices (
  platform, visitor_id, app_version, last_seen
)
SELECT DISTINCT ON (platform, visitor_id)
       platform,
       visitor_id,
       app_version,
       created_at
FROM admin_page_views
WHERE platform IN ('ios_native', 'android_native', 'native')
  AND NOT starts_with(path, '/_celeb')
ORDER BY platform, visitor_id, created_at DESC, id DESC;

CREATE OR REPLACE FUNCTION admin_page_views_track_traffic_rollups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_platform text := COALESCE(NEW.platform, 'unknown');
BEGIN
  IF NOT starts_with(NEW.path, '/_celeb') THEN
    INSERT INTO admin_traffic_daily_visitors (
      day_kst, platform, visitor_id, pv
    ) VALUES (
      (NEW.created_at AT TIME ZONE 'Asia/Seoul')::date,
      v_platform,
      NEW.visitor_id,
      1
    )
    ON CONFLICT (day_kst, platform, visitor_id) DO UPDATE
    SET pv = admin_traffic_daily_visitors.pv + 1;

    IF NEW.platform IN ('ios_native', 'android_native', 'native') THEN
      INSERT INTO admin_app_version_devices (
        platform, visitor_id, app_version, last_seen
      ) VALUES (
        NEW.platform, NEW.visitor_id, NEW.app_version, NEW.created_at
      )
      ON CONFLICT (platform, visitor_id) DO UPDATE
      SET app_version = EXCLUDED.app_version,
          last_seen = EXCLUDED.last_seen
      WHERE admin_app_version_devices.last_seen <= EXCLUDED.last_seen;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_page_views_track_traffic_rollups()
  FROM public, anon, authenticated;

CREATE TRIGGER trg_admin_page_views_track_traffic_rollups
  AFTER INSERT ON admin_page_views
  FOR EACH ROW EXECUTE FUNCTION admin_page_views_track_traffic_rollups();

CREATE OR REPLACE FUNCTION admin_traffic_daily(p_since date)
RETURNS TABLE(day date, platform text, pv bigint, uv bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT day_kst AS day,
         platform,
         sum(pv)::bigint AS pv,
         count(*)::bigint AS uv
  FROM admin_traffic_daily_visitors
  WHERE day_kst >= p_since
  GROUP BY day_kst, platform
  ORDER BY day_kst, platform;
$$;

CREATE OR REPLACE FUNCTION admin_traffic_totals(p_since date)
RETURNS TABLE(platform text, pv bigint, uv bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT platform,
         sum(pv)::bigint AS pv,
         count(DISTINCT visitor_id)::bigint AS uv
  FROM admin_traffic_daily_visitors
  WHERE day_kst >= p_since
  GROUP BY platform
  ORDER BY platform;
$$;

CREATE OR REPLACE FUNCTION admin_app_version_share(p_since date)
RETURNS TABLE(platform text, app_version text, devices bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT platform,
         COALESCE(app_version, '미상') AS app_version,
         count(*)::bigint AS devices
  FROM admin_app_version_devices
  WHERE last_seen >= ((p_since::text || 'T00:00:00+09:00')::timestamptz)
  GROUP BY platform, COALESCE(app_version, '미상')
  ORDER BY platform, devices DESC;
$$;

REVOKE EXECUTE ON FUNCTION admin_traffic_daily(date)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_traffic_totals(date)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_app_version_share(date)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_traffic_daily(date) TO service_role;
GRANT EXECUTE ON FUNCTION admin_traffic_totals(date) TO service_role;
GRANT EXECUTE ON FUNCTION admin_app_version_share(date) TO service_role;

ANALYZE admin_traffic_daily_visitors;
ANALYZE admin_app_version_devices;
