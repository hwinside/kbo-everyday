# Admin server/DB health

## Goal

Show the current Supabase server and database health inside `/admin/system` without exposing credentials to the browser or adding a Mac mini dependency.

## Scope

- Read-only cards for CPU load, memory, root disk, PostgreSQL connections, pool waits, and oldest transaction.
- Service state for DB, Auth, REST, and Storage.
- Refresh every 60 seconds and show the observation timestamp and partial-source failures.
- A required source failure must never leave the overall badge green; failed refreshes keep the last value but visibly mark it stale.
- Derive current warning/critical state from the same resource thresholds as the hosted alert catalog where the raw metric is available.

## Safety

- The route requires the existing admin session/PIN gate.
- Supabase service-role and management credentials stay server-side.
- No restart, resize, query cancellation, or other mutation is added.
- Grafana alert history and incident ACK history are out of this first slice; the dashboard links current health while hosted alert routing remains authoritative.

## Acceptance

1. An authenticated admin can see current values on mobile and desktop.
2. An unauthenticated request receives 401.
3. One unavailable upstream source does not hide data from the other source.
4. Secrets never appear in the response or client bundle.
5. Parser and health-state regression tests pass.
