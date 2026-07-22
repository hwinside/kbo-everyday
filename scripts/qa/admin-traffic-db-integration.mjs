/**
 * Read-only production-data regression for the admin dwell rollup.
 *
 * Compares the legacy filter-first RPC semantics against the proposed
 * visitor-wide logical-session + per-event-day/platform slice semantics for
 * 1/7/30-day KST windows. No schema or row is changed.
 */
import "./_env.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const MANAGEMENT_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN || "";
const PROJECT_REF = SUPABASE_URL.match(/^https:\/\/([a-z0-9]+)\./)?.[1] || "";

if (!PROJECT_REF || !MANAGEMENT_TOKEN) {
  console.error("FATAL: Supabase project ref / SUPABASE_MANAGEMENT_TOKEN env 필요");
  process.exit(2);
}

const query = `
SET statement_timeout = '120s';
WITH periods(days, since_ts) AS (
  VALUES
    (1,  ((timezone('Asia/Seoul', now())::date)::text || 'T00:00:00+09:00')::timestamptz),
    (7,  ((timezone('Asia/Seoul', now())::date - 6)::text || 'T00:00:00+09:00')::timestamptz),
    (30, ((timezone('Asia/Seoul', now())::date - 29)::text || 'T00:00:00+09:00')::timestamptz)
),
base AS MATERIALIZED (
  SELECT id,
         COALESCE(platform, 'unknown') AS platform,
         visitor_id,
         created_at,
         dwell_ms
  FROM admin_page_dwell
  WHERE created_at >= (SELECT min(since_ts) FROM periods)
),
legacy_ordered AS (
  SELECT periods.days,
         base.*,
         lag(created_at) OVER (
           PARTITION BY periods.days, visitor_id
           ORDER BY created_at, id
         ) AS previous_at
  FROM periods
  JOIN base ON base.created_at >= periods.since_ts
),
legacy_marked AS (
  SELECT *,
         CASE
           WHEN previous_at IS NULL
             OR created_at - previous_at > interval '30 minutes'
           THEN 1 ELSE 0
         END AS new_session
  FROM legacy_ordered
),
legacy_numbered AS (
  SELECT *,
         sum(new_session) OVER (
           PARTITION BY days, visitor_id
           ORDER BY created_at, id
           ROWS UNBOUNDED PRECEDING
         ) AS session_no
  FROM legacy_marked
),
legacy_session_totals AS (
  SELECT days,
         platform,
         visitor_id,
         session_no,
         sum(dwell_ms)::bigint AS session_ms
  FROM legacy_numbered
  GROUP BY days, platform, visitor_id, session_no
),
legacy AS (
  SELECT days,
         platform,
         count(*)::bigint AS sessions,
         round(avg(session_ms))::bigint AS avg_ms,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY session_ms))::bigint AS median_ms
  FROM legacy_session_totals
  GROUP BY days, platform
),
rollup_ordered AS (
  SELECT base.*,
         lag(created_at) OVER (
           PARTITION BY visitor_id
           ORDER BY created_at, id
         ) AS previous_at
  FROM base
),
rollup_marked AS (
  SELECT *,
         CASE
           WHEN previous_at IS NULL
             OR created_at - previous_at > interval '30 minutes'
           THEN 1 ELSE 0
         END AS new_session
  FROM rollup_ordered
),
rollup_numbered AS (
  SELECT *,
         sum(new_session) OVER (
           PARTITION BY visitor_id
           ORDER BY created_at, id
           ROWS UNBOUNDED PRECEDING
         ) AS session_no
  FROM rollup_marked
),
rollup_session_totals AS (
  SELECT periods.days,
         numbered.platform,
         numbered.visitor_id,
         numbered.session_no,
         sum(numbered.dwell_ms)::bigint AS session_ms
  FROM periods
  JOIN rollup_numbered AS numbered
    ON numbered.created_at >= periods.since_ts
  GROUP BY periods.days, numbered.platform, numbered.visitor_id, numbered.session_no
),
rollup AS (
  SELECT days,
         platform,
         count(*)::bigint AS sessions,
         round(avg(session_ms))::bigint AS avg_ms,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY session_ms))::bigint AS median_ms
  FROM rollup_session_totals
  GROUP BY days, platform
)
SELECT COALESCE(legacy.days, rollup.days) AS days,
       COALESCE(legacy.platform, rollup.platform) AS platform,
       legacy.sessions AS legacy_sessions,
       rollup.sessions AS rollup_sessions,
       legacy.avg_ms AS legacy_avg_ms,
       rollup.avg_ms AS rollup_avg_ms,
       legacy.median_ms AS legacy_median_ms,
       rollup.median_ms AS rollup_median_ms,
       legacy.sessions IS NOT DISTINCT FROM rollup.sessions
         AND legacy.avg_ms IS NOT DISTINCT FROM rollup.avg_ms
         AND legacy.median_ms IS NOT DISTINCT FROM rollup.median_ms AS matches
FROM legacy
FULL JOIN rollup USING (days, platform)
ORDER BY days, platform;
`;

const response = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  },
);

if (!response.ok) {
  const body = await response.text();
  console.error(`FATAL: management query ${response.status}: ${body.slice(0, 500)}`);
  process.exit(2);
}

const rows = await response.json();
if (!Array.isArray(rows) || rows.length === 0) {
  console.error("FATAL: comparison returned no rows");
  process.exit(2);
}

for (const row of rows) {
  const mark = row.matches ? "✓" : "✗";
  console.log(
    `${mark} ${row.days}d ${row.platform}: ` +
      `sessions ${row.legacy_sessions}/${row.rollup_sessions}, ` +
      `avg ${row.legacy_avg_ms}/${row.rollup_avg_ms}, ` +
      `median ${row.legacy_median_ms}/${row.rollup_median_ms}`,
  );
}

const mismatches = rows.filter((row) => !row.matches);
console.log(`\n${rows.length - mismatches.length}/${rows.length} exact matches`);
if (mismatches.length > 0) process.exit(1);
