# Game snapshot rollout / rollback

Default: both switches off. This PR does not enable production or apply the migration.
Requires the event-order PR #1597 and last-good UI PR #1598 before read activation.

## Approval and activation gates
1. Independent SQL review + explicit database rollout authorization. Apply
   `20261101130000_game_delivery_snapshots.sql` with the normal migration pipeline.
   Anonymous/authenticated roles must have no read/write/RPC privileges.
2. Enable `GAME_SNAPSHOT_WRITE_ENABLED=1`, keep `GAME_SNAPSHOT_READ_ENABLED` unset.
   Verify the existing publisher runs in icn1, discovers upcoming/live/final games,
   and writes four channel rows. Its current Redis lease and monotonic epoch remain
   required for collection, but serving snapshots does not depend on Redis.
3. Set explicit `GAME_SNAPSHOT_GAME_IDS` to the reviewed canonical game IDs
   (KS1: `20261103SSKT0`). Empty scope serves nothing from snapshots. Old games
   and no-game dates outside this list retain existing paths. Add each upcoming
   KS game before its start and verify its four rows.
   Independent end-user QA before read activation: cold browser, mobile,
   direct/multiplex/watchdog/Realtime paths, strict source isolation, final archive.
   Require valid last-good rows for every currently served game and date.
   In-scope games without rows produce explicit snapshot_pending; keep read off
   for that game until warmup rows are verified. Scheduled games are collected
   throughout their game date, not only after the live transition.
4. Enable `GAME_SNAPSHOT_READ_ENABLED=1` only after the above GO. Confirm that
   in-scope public requests make zero KBO/Naver calls even under Redis/KBO/Naver outages.
   Missing/store-failed rows return bounded 503; existing UI last-good must remain.
5. Check entire-game 5xx rate AND source observation age. A 200 with degraded=true
   is delayed service, not restored live coverage. Frozen archives are explicitly
   marked archived; do not count their observation age as a live incident.

## Fault injection (independent reviewer)
- KBO and Naver timeout/403/429/malformed output: saved payload unchanged, original
  observation time preserved, stale indication shown; no per-user upstream retry.
- Redis unavailable: collection may stop; public stored reads still work.
- Supabase unavailable: bounded store error, no upstream fallback stampede; client
  keeps its last-good state and shows delay rather than clearing content.
- Out-of-order old epoch/ordinal and old observation time: SQL rejects overwrite.
- Final transition: all four channel observations must be >=10 minutes after first
  official final detail observation before archival; no archive on partial data.
- Anonymous spoofed collector header/hostname must not bypass stored reads.
- Test full game including final transition, background/resume and reconnect;
  a single healthy sample is not a whole-game PASS.

## Rollback
Disable only `GAME_SNAPSHOT_READ_ENABLED` to restore existing user-serving paths.
Keep durable snapshots; no destructive database rollback is required.
If collector writes malfunction, disable WRITE after READ is off. Do not mark an
upstream outage recovered merely because rollback enables live retries again.

## Limits
This preserves known data, not unavailable new plays. All upstreams down means
honest delayed coverage. Collector/API/DB simultaneous failure cannot guarantee
fresh data. Archive closes after a ten-minute final settling window; later official
corrections require a controlled re-collection. No billing/auth changes included.
