# Publisher live-frame investigation (2026-11-03)

## Scope

Observation only: this change does not restore live delivery or change routing,
source validation, payload limits, INSERT fencing, or polling fallback.
`#1590` remains HOLD for the live channel. #1599 is a separate snapshot-serving
change touching these files; keep its rollout out of this diagnostic patch.

## Reproduced failure path

`internalGetRequest` creates `https://internal.local/api/game-live` requests.
`gameLiveRoute` uses the request origin to HTTP-fetch `/api/games` as an
independent slate/starter witness. The publisher invokes the handler directly,
but that nested fetch still uses the synthetic origin. With that network request
rejected, the actual handler returns 503 / `starter-witness-failed` and no live
frame can be published. A controlled-fetch regression exercises this actual
handler, not a reimplementation.

This proves a code-level failure path, not the exclusive cause of every historic
missing frame. Source failure, oversize, INSERT rejection and timeout remain
separate possibilities until production observations distinguish them. Table
retention/cleanup must also be checked before calling retained rows all history.

Do not simply replace the origin with production: that introduces public
self-fetch dependency. A recovery patch must preserve independent slate/starter
validation and the existing abort/deadline contract. Calling `/api/games` directly
also requires care: it has an optional nested relay self-fetch and its own source
budget. This change deliberately does not bypass those checks.

## Runtime evidence

One `[relay-publisher-channels]` JSON summary per locked invocation in `finally`:
- `counts`: channel + outcome + optional HTTP status/allowlisted stage;
- `maxBytes`: largest serialized payload observed per channel.

Counts cover fetch success, HTTP failure, fetch/JSON exception, unchanged,
oversize, aborted and every INSERT outcome. Counters aggregate tick events (not
users or unique games); summaries include all games in that invocation. Bodies,
URLs, credentials and exception messages are never logged. Unknown stage headers
are mapped to `other`. An empty summary may mean discovery found no games.
HTTP 200 from the cron is not a channel-success claim.

## Verification

`tsx --test tests/relay-publisher-observations.test.ts` covers the actual handler
failure, HTTP/exception/JSON/oversize/INSERT distinctions, unchanged aggregation,
abort fencing and log redaction. Existing discovery tests are retained.

Independent reviewer should confirm the summary hook in the cron, verify the
production source SHA, then inspect live counters on the next active game.
Existing KBO-only `relay-full` rows correctly need no `relay-delta` rows.
