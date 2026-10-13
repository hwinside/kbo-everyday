# Cron recovery 2026-10-02

## Official season evidence
- KBO 2026-09-30 notice: https://www.koreabaseball.com/MediaNews/Notice/View.aspx?bdSe=12172
- Attached official schedule covers September 30 through October 12: October 1 scheduled/reserve, October 2 empty, October 3–7 scheduled, October 8 reserve, October 9–12 scheduled/reserve.
- Window extends only to October 12. `finalized=false`: additional rain postponements remain possible. October 13+, unknown years, exhibition dates remain fail-closed. Empty responses still require existing cross-source verification.

## Date isolation
Today failing must not suppress yesterday's ingestion. Fetch both with allSettled, deduplicate finals, ingest successful dates, then report HTTP 500 / job error if any date failed. Return failedDates and completed ingestion counts together. No manual replay or data write is included in deployment. Existing roster mapping gaps are separate; do not infer identities from name alone.

## Retention lock
Keep SHARE ROW EXCLUSIVE on both raw tables: relaxing it can admit backdated inserts between the raw-empty barrier and rollup deletes, or race ingestion triggers. Only rollup cleanup changes from NOWAIT to a function-local 500ms lock_timeout. No retry, no statement_timeout increase, no changes to backup freshness, privileges, audit or deletion predicates. A long writer still yields 55P03 and full rollback of this transaction; earlier raw batches stay committed.

## Review checks
Reviewer runs games-naver-fallback-smoke.ts, game-logs-date-isolation.ts, venue-stats-s1b-db-route-integration.ts and required CI/deploy tiers. PG17 batches gate now applies the new migration and covers long lock rejection, short dwell writer completion, timeout restoration in the same connection, remaining-raw barrier, role rejection, deletion counts and phase audits. Production lock behavior is unverified until rollout.

## Rollout / rollback
Independent exact-SHA GO then explicit owner merge and production migration approval required. App date recovery and DB rollup lock change are independent. Migration changes only rollups function; rollback by restoring that function from 20260925 migration. Application rollback restores previous deployment (and its known date-fetch failure). Do not mark operational recovery before reviewer production QA and regular cron evidence.
