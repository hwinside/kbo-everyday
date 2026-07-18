-- Admin traffic dashboard performance (#cs 2026-07-18: 느림 + 간헐 500).
-- Prod measurements (pg_stat_statements): the 5 RPCs behind /api/admin/traffic
-- average 0.4~0.6s each with worst cases of 6.3~7.8s — brushing the 8s
-- authenticator statement_timeout, which is where the intermittent 500s come
-- from. Two structural fixes here (plus a 60s route cache in the app):
--
--   1) admin_app_device_totals() counted DISTINCT visitor_id over ALL native
--      page views (all-time scan, ~1.0s today, grows forever). Replace with an
--      incremental rollup table maintained by an insert trigger; the function
--      becomes a ~6k-row aggregate with an unchanged signature (route untouched).
--
--   2) admin_traffic_daily/_totals read the whole heap (103MB) to get
--      (created_at, platform, visitor_id). A covering index turns them into
--      index-only scans.

-- 1) Incremental unique-device rollup ----------------------------------------
-- One row per (platform, visitor_id) ever seen from a native shell, celebration
-- telemetry excluded — the exact population admin_app_device_totals() counted.
CREATE TABLE IF NOT EXISTS admin_app_devices (
  platform    text        NOT NULL,
  visitor_id  text        NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, visitor_id)
);

-- service_role only (RLS on + zero policies = deny all API roles).
ALTER TABLE admin_app_devices ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION admin_app_devices_track()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.platform IN ('ios_native', 'android_native', 'native')
     AND NOT starts_with(NEW.path, '/_celeb') THEN
    INSERT INTO admin_app_devices (platform, visitor_id, first_seen)
    VALUES (NEW.platform, NEW.visitor_id, COALESCE(NEW.created_at, now()))
    ON CONFLICT (platform, visitor_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apv_track_devices ON admin_page_views;
CREATE TRIGGER trg_apv_track_devices
  AFTER INSERT ON admin_page_views
  FOR EACH ROW EXECUTE FUNCTION admin_app_devices_track();

-- Backfill from existing history (idempotent; ~6k devices from ~295k rows).
INSERT INTO admin_app_devices (platform, visitor_id, first_seen)
SELECT platform, visitor_id, min(created_at)
FROM admin_page_views
WHERE platform IN ('ios_native', 'android_native', 'native')
  AND NOT starts_with(path, '/_celeb')
GROUP BY platform, visitor_id
ON CONFLICT (platform, visitor_id) DO NOTHING;

-- Same signature/semantics as before — the API route needs no change.
CREATE OR REPLACE FUNCTION admin_app_device_totals()
RETURNS TABLE(platform text, devices bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT platform, count(*) AS devices
  FROM admin_app_devices
  GROUP BY platform
  ORDER BY platform;
$$;

REVOKE EXECUTE ON FUNCTION admin_app_device_totals() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_app_device_totals() TO service_role;

-- 2) Partial covering index for window PV/UV aggregates ----------------------
-- admin_traffic_daily/_totals filter `created_at >= since AND NOT
-- starts_with(path, '/_celeb')` (the celebration-exclusion was added by
-- 20260625_admin_traffic_collection_fix, so the live functions read `path`).
-- A plain (created_at) INCLUDE (platform, visitor_id) index can't be
-- index-only because `path` isn't covered. Instead, fold the immutable
-- celebration predicate into a PARTIAL index: the planner matches the query's
-- identical predicate to the index, so `path` never needs a heap fetch and the
-- scan stays index-only. Prod EXPLAIN (post-VACUUM): 7d daily 1651ms->354ms
-- (Index Only Scan). starts_with(text,text) is IMMUTABLE, so it's valid in a
-- partial-index predicate.
CREATE INDEX IF NOT EXISTS idx_apv_created_covering
  ON admin_page_views (created_at) INCLUDE (platform, visitor_id)
  WHERE NOT starts_with(path, '/_celeb');
