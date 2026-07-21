-- Admin traffic dwell rollup (#cs 2026-07-21: 30d API statement timeout).
--
-- admin_dwell_by_platform() previously sessionized every raw dwell beacon on
-- each dashboard request. The 30-day window now contains ~400k events, so the
-- two window passes + sort can exceed the authenticator's 8s statement_timeout.
--
-- Preserve the existing contract exactly:
--   * session boundaries are visitor-wide (not visitor+platform)
--   * a reporting window filters raw events first, so a midnight-crossing
--     session contributes only the in-window dwell
--
-- One logical session row plus per-KST-day/platform slices keeps both rules.
-- Dashboard reads aggregate ~session-day slices instead of raw beacons.

CREATE TABLE IF NOT EXISTS admin_dwell_sessions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  visitor_id    text        NOT NULL,
  session_start timestamptz NOT NULL,
  session_end   timestamptz NOT NULL,
  UNIQUE (visitor_id, session_start)
);

CREATE TABLE IF NOT EXISTS admin_dwell_session_slices (
  session_id  bigint  NOT NULL REFERENCES admin_dwell_sessions(id) ON DELETE CASCADE,
  platform    text    NOT NULL,
  day_kst     date    NOT NULL,
  dwell_ms    bigint  NOT NULL CHECK (dwell_ms >= 0),
  event_count integer NOT NULL CHECK (event_count > 0),
  PRIMARY KEY (session_id, platform, day_kst)
);

ALTER TABLE admin_dwell_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_dwell_session_slices ENABLE ROW LEVEL SECURITY;

-- Trigger lookup is visitor-wide to match the legacy LAG partition key.
CREATE INDEX IF NOT EXISTS idx_admin_dwell_sessions_visitor_end
  ON admin_dwell_sessions (visitor_id, session_end DESC)
  INCLUDE (session_start);

-- p_since is always a KST calendar date. INCLUDE keeps the selected session
-- contribution covered once the visibility map permits an index-only scan.
CREATE INDEX IF NOT EXISTS idx_admin_dwell_slices_day_covering
  ON admin_dwell_session_slices (day_kst)
  INCLUDE (session_id, platform, dwell_ms);

-- Block dwell inserts only for the short backfill transaction. This closes the
-- gap between the backfill snapshot and trigger installation: writers resume
-- after commit with the trigger already active.
LOCK TABLE admin_page_dwell IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE admin_dwell_backfill ON COMMIT DROP AS
WITH ordered AS (
  SELECT id,
         visitor_id,
         COALESCE(platform, 'unknown') AS platform,
         created_at,
         dwell_ms,
         lag(created_at) OVER (
           PARTITION BY visitor_id
           ORDER BY created_at, id
         ) AS prev
  FROM admin_page_dwell
), marked AS (
  SELECT *,
         CASE
           WHEN prev IS NULL OR created_at - prev > interval '30 minutes' THEN 1
           ELSE 0
         END AS new_session
  FROM ordered
)
SELECT *,
       sum(new_session) OVER (
         PARTITION BY visitor_id
         ORDER BY created_at, id
         ROWS UNBOUNDED PRECEDING
       ) AS session_no
FROM marked;

INSERT INTO admin_dwell_sessions (visitor_id, session_start, session_end)
SELECT visitor_id, min(created_at), max(created_at)
FROM admin_dwell_backfill
GROUP BY visitor_id, session_no;

WITH bounds AS (
  SELECT visitor_id, session_no, min(created_at) AS session_start
  FROM admin_dwell_backfill
  GROUP BY visitor_id, session_no
)
INSERT INTO admin_dwell_session_slices (
  session_id,
  platform,
  day_kst,
  dwell_ms,
  event_count
)
SELECT sessions.id,
       events.platform,
       (events.created_at AT TIME ZONE 'Asia/Seoul')::date AS day_kst,
       sum(events.dwell_ms)::bigint,
       count(*)::integer
FROM admin_dwell_backfill AS events
JOIN bounds
  ON bounds.visitor_id = events.visitor_id
 AND bounds.session_no = events.session_no
JOIN admin_dwell_sessions AS sessions
  ON sessions.visitor_id = bounds.visitor_id
 AND sessions.session_start = bounds.session_start
GROUP BY sessions.id, events.platform, day_kst;

CREATE OR REPLACE FUNCTION admin_page_dwell_track_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_platform text := COALESCE(NEW.platform, 'unknown');
  v_day_kst date := (NEW.created_at AT TIME ZONE 'Asia/Seoul')::date;
  v_ids bigint[];
  v_session_id bigint;
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  -- The legacy function partitions only by visitor_id. Keep that exact key so
  -- a visitor seen on multiple platforms still has one logical 30m session.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.visitor_id, 0));

  SELECT array_agg(s.id ORDER BY s.id),
         min(s.session_start),
         max(s.session_end)
  INTO v_ids, v_start, v_end
  FROM (
    SELECT id, session_start, session_end
    FROM admin_dwell_sessions
    WHERE visitor_id = NEW.visitor_id
      AND session_start <= NEW.created_at + interval '30 minutes'
      AND session_end >= NEW.created_at - interval '30 minutes'
    ORDER BY id
    FOR UPDATE
  ) AS s;

  IF v_ids IS NULL THEN
    INSERT INTO admin_dwell_sessions (visitor_id, session_start, session_end)
    VALUES (NEW.visitor_id, NEW.created_at, NEW.created_at)
    RETURNING id INTO v_session_id;
  ELSE
    v_session_id := v_ids[1];

    -- A delayed event can bridge two logical sessions. Move every platform/day
    -- slice into the survivor before deleting the superseded session rows.
    IF cardinality(v_ids) > 1 THEN
      INSERT INTO admin_dwell_session_slices (
        session_id, platform, day_kst, dwell_ms, event_count
      )
      SELECT v_session_id,
             platform,
             day_kst,
             sum(dwell_ms)::bigint,
             sum(event_count)::integer
      FROM admin_dwell_session_slices
      WHERE session_id = ANY(v_ids)
        AND session_id <> v_session_id
      GROUP BY platform, day_kst
      ON CONFLICT (session_id, platform, day_kst) DO UPDATE
      SET dwell_ms = admin_dwell_session_slices.dwell_ms + EXCLUDED.dwell_ms,
          event_count = admin_dwell_session_slices.event_count + EXCLUDED.event_count;

      DELETE FROM admin_dwell_sessions
      WHERE id = ANY(v_ids)
        AND id <> v_session_id;
    END IF;

    UPDATE admin_dwell_sessions
    SET session_start = LEAST(v_start, NEW.created_at),
        session_end = GREATEST(v_end, NEW.created_at)
    WHERE id = v_session_id;
  END IF;

  INSERT INTO admin_dwell_session_slices (
    session_id, platform, day_kst, dwell_ms, event_count
  ) VALUES (
    v_session_id, v_platform, v_day_kst, NEW.dwell_ms, 1
  )
  ON CONFLICT (session_id, platform, day_kst) DO UPDATE
  SET dwell_ms = admin_dwell_session_slices.dwell_ms + EXCLUDED.dwell_ms,
      event_count = admin_dwell_session_slices.event_count + 1;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_page_dwell_track_session()
  FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_admin_page_dwell_track_session ON admin_page_dwell;
CREATE TRIGGER trg_admin_page_dwell_track_session
  AFTER INSERT ON admin_page_dwell
  FOR EACH ROW EXECUTE FUNCTION admin_page_dwell_track_session();

CREATE OR REPLACE FUNCTION admin_dwell_by_platform(p_since date)
RETURNS TABLE(platform text, sessions bigint, avg_ms numeric, median_ms numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH session_totals AS (
    SELECT session_id, platform, sum(dwell_ms)::bigint AS session_ms
    FROM admin_dwell_session_slices
    WHERE day_kst >= p_since
    GROUP BY session_id, platform
  )
  SELECT platform,
         count(*) AS sessions,
         round(avg(session_ms)) AS avg_ms,
         round(
           percentile_cont(0.5) WITHIN GROUP (ORDER BY session_ms)::numeric
         ) AS median_ms
  FROM session_totals
  GROUP BY platform
  ORDER BY platform;
$$;

REVOKE EXECUTE ON FUNCTION admin_dwell_by_platform(date)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_dwell_by_platform(date) TO service_role;

ANALYZE admin_dwell_sessions;
ANALYZE admin_dwell_session_slices;
