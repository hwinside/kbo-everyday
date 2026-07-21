-- Admin traffic dwell rollup (#cs 2026-07-21: 30d API statement timeout).
--
-- admin_dwell_by_platform() previously sessionized every raw dwell beacon on
-- each dashboard request. The 30-day window now contains ~400k events, so the
-- two window passes + sort can exceed the authenticator's 8s statement_timeout.
-- Keep one row per completed/in-progress visitor session instead. Dashboard
-- reads become a range aggregate over ~50k sessions, while the insert trigger
-- incrementally maintains the current session.

CREATE TABLE IF NOT EXISTS admin_dwell_sessions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      text        NOT NULL,
  visitor_id    text        NOT NULL,
  session_start timestamptz NOT NULL,
  session_end   timestamptz NOT NULL,
  dwell_ms      bigint      NOT NULL CHECK (dwell_ms >= 0),
  event_count   integer     NOT NULL CHECK (event_count > 0)
);

ALTER TABLE admin_dwell_sessions ENABLE ROW LEVEL SECURITY;

-- Dashboard range scan: session_end defines which reporting window owns a
-- session. INCLUDE keeps the aggregate index-only once visibility permits.
CREATE INDEX IF NOT EXISTS idx_admin_dwell_sessions_end_covering
  ON admin_dwell_sessions (session_end)
  INCLUDE (platform, dwell_ms);

-- Trigger lookup: latest/overlapping sessions for one visitor + platform.
CREATE INDEX IF NOT EXISTS idx_admin_dwell_sessions_visitor_end
  ON admin_dwell_sessions (platform, visitor_id, session_end DESC)
  INCLUDE (session_start, dwell_ms, event_count);

-- Block dwell inserts only for the short backfill transaction. This closes the
-- gap between the backfill snapshot and trigger installation: writers resume
-- after commit with the trigger already active.
LOCK TABLE admin_page_dwell IN SHARE ROW EXCLUSIVE MODE;

WITH ordered AS (
  SELECT id,
         COALESCE(platform, 'unknown') AS platform,
         visitor_id,
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
), numbered AS (
  SELECT *,
         sum(new_session) OVER (
           PARTITION BY visitor_id
           ORDER BY created_at, id
           ROWS UNBOUNDED PRECEDING
         ) AS session_no
  FROM marked
)
INSERT INTO admin_dwell_sessions (
  platform,
  visitor_id,
  session_start,
  session_end,
  dwell_ms,
  event_count
)
SELECT platform,
       visitor_id,
       min(created_at),
       max(created_at),
       sum(dwell_ms)::bigint,
       count(*)::integer
FROM numbered
GROUP BY platform, visitor_id, session_no;

CREATE OR REPLACE FUNCTION admin_page_dwell_track_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_platform text := COALESCE(NEW.platform, 'unknown');
  v_ids bigint[];
  v_start timestamptz;
  v_end timestamptz;
  v_dwell bigint;
  v_events integer;
BEGIN
  -- Serialize only one visitor/platform pair. A delayed beacon can bridge two
  -- sessions; locking + merging every overlap preserves the 30-minute rule.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_platform || ':' || NEW.visitor_id, 0)
  );

  SELECT array_agg(s.id ORDER BY s.session_end),
         min(s.session_start),
         max(s.session_end),
         COALESCE(sum(s.dwell_ms), 0)::bigint,
         COALESCE(sum(s.event_count), 0)::integer
  INTO v_ids, v_start, v_end, v_dwell, v_events
  FROM (
    SELECT id, session_start, session_end, dwell_ms, event_count
    FROM admin_dwell_sessions
    WHERE platform = v_platform
      AND visitor_id = NEW.visitor_id
      AND session_start <= NEW.created_at + interval '30 minutes'
      AND session_end >= NEW.created_at - interval '30 minutes'
    ORDER BY session_end
    FOR UPDATE
  ) AS s;

  IF v_ids IS NULL THEN
    INSERT INTO admin_dwell_sessions (
      platform, visitor_id, session_start, session_end, dwell_ms, event_count
    ) VALUES (
      v_platform, NEW.visitor_id, NEW.created_at, NEW.created_at, NEW.dwell_ms, 1
    );
  ELSIF cardinality(v_ids) = 1 THEN
    UPDATE admin_dwell_sessions
    SET session_start = LEAST(v_start, NEW.created_at),
        session_end = GREATEST(v_end, NEW.created_at),
        dwell_ms = v_dwell + NEW.dwell_ms,
        event_count = v_events + 1
    WHERE id = v_ids[1];
  ELSE
    DELETE FROM admin_dwell_sessions WHERE id = ANY(v_ids);
    INSERT INTO admin_dwell_sessions (
      platform, visitor_id, session_start, session_end, dwell_ms, event_count
    ) VALUES (
      v_platform,
      NEW.visitor_id,
      LEAST(v_start, NEW.created_at),
      GREATEST(v_end, NEW.created_at),
      v_dwell + NEW.dwell_ms,
      v_events + 1
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_page_dwell_track_session()
  FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_admin_page_dwell_track_session ON admin_page_dwell;
CREATE TRIGGER trg_admin_page_dwell_track_session
  AFTER INSERT ON admin_page_dwell
  FOR EACH ROW EXECUTE FUNCTION admin_page_dwell_track_session();

-- A session is reported in the window containing its latest event. Sessions
-- crossing KST midnight stay one visit; at most the pre-midnight tail (under
-- the 30-minute boundary) is attributed to the later window.
CREATE OR REPLACE FUNCTION admin_dwell_by_platform(p_since date)
RETURNS TABLE(platform text, sessions bigint, avg_ms numeric, median_ms numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT platform,
         count(*) AS sessions,
         round(avg(dwell_ms)) AS avg_ms,
         round(
           percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell_ms)::numeric
         ) AS median_ms
  FROM admin_dwell_sessions
  WHERE session_end >= ((p_since::text || 'T00:00:00+09:00')::timestamptz)
  GROUP BY platform
  ORDER BY platform;
$$;

REVOKE EXECUTE ON FUNCTION admin_dwell_by_platform(date)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_dwell_by_platform(date) TO service_role;

ANALYZE admin_dwell_sessions;
