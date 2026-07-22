# Hosted Supabase Incident Prevention — Spec

## Objective

Detect Supabase saturation before user-visible failure, attribute abnormal `/auth/v1/user` traffic, notify through two independent hosted paths, and apply only reversible load shedding. The production monitoring path must have zero Mac mini, launchd, OpenClaw, or home-network dependency.

## Incident evidence

- 2026-07-22 peak: database CPU 100%, memory about 90%, connection-pool timeouts.
- `/auth/v1/user` peaked at 9,911 requests/minute; PR #775 reduced it to 3,480/minute.
- The existing one-minute probe detected failure but its local alert delivery failed. It is not part of the target architecture.

## Architecture

1. Grafana Cloud's managed Supabase integration scrapes the Supabase Metrics API every 60 seconds.
2. One Supabase Log Drain sends stack logs directly to Grafana Cloud Loki.
3. Grafana Synthetic Monitoring runs a composite API journey from two hosted probe locations.
4. Better Stack performs an independent three-minute availability check and alert-path heartbeat.
5. Grafana alert webhooks call a Cloudflare Worker. A per-fingerprint Durable Object serializes incident updates before the Worker sends Slack and Telegram notifications directly.
6. Reversible load shedding is stored outside Supabase. Destructive operations such as restart, resize, and PITR always require explicit human approval.

## Required signals

- CPU busy, system load, memory excluding cache, swap.
- Data disk usage, disk I/O utilization, disk wait, seven-day exhaustion forecast.
- PostgreSQL/Supavisor/PgBouncer active and waiting connections, pool checkout latency, transactions over one second.
- Database health, Realtime replication lag, synthetic REST/app/auth journey status.
- `/auth/v1/user` request rate, p95 latency, 4xx and 5xx ratio, release/runtime/source labels where available.
- Monitoring freshness and alert-delivery acknowledgement.

## Initial thresholds

- CPU: warning above 70% for 5 minutes; critical above 85% for 3 minutes.
- Memory: warning above 75% for 5 minutes; critical above 85% for 3 minutes.
- Disk used: warning above 75%; critical above 85%; warning when forecast exhaustion is under 7 days.
- Disk I/O utilization: critical above 80% for 5 minutes.
- Waiting DB clients: critical when non-zero for 3 minutes. Pool checkout over one second: warning above 1%, critical above 5%.
- `/auth/v1/user`: warning above max(2x same-time baseline, 5,000/min) for 3 minutes; critical above max(3x baseline, 8,000/min) for 2 minutes.
- Auth 5xx: critical above 1% for 2 minutes. Auth p95: critical above 1 second for 3 minutes.
- Synthetic: critical after two consecutive failures; recovery after three consecutive passes.
- Missing metrics or missing heartbeat: critical after 3 minutes.

Thresholds are recalibrated after seven days of post-fix traffic without weakening the absolute safety ceilings.

## Alert and incident contract

- MTTD at most 2 minutes, Slack and Telegram delivery at most 3 minutes, mitigation decision at most 5 minutes.
- Every critical alert has a stable incident fingerprint and opens or updates one Slack thread.
- Alert payload includes timestamps, severity, current value, threshold, dashboard/log links, deployment SHA, and recommended first action.
- A resolved fingerprint that fires again creates a new episode. ACK links are episode-bound, GET is read-only, and only an explicit POST records ownership.
- Incident delivery and escalation keep a per-channel ledger; retrying a failed channel cannot resend a channel that already succeeded.
- No acknowledgement within 3 minutes triggers a second hosted escalation path.
- Recovery requires metrics, synthetic probes, and an actual authenticated user journey; a static page 200 is insufficient.

## Safe automation

- Allowed automatically: pause non-critical polling/cron work, reduce non-critical Realtime subscriptions, and enable a bounded public-route auth bypass already designed to avoid remote user verification.
- Forbidden automatically: project restart, compute resize, disk resize, key rotation, database writes outside the bounded incident-state store, and PITR.
- Every automatic action has an expiry and restores automatically after three consecutive healthy checks.

## Security and cost

- Secrets live only in Grafana/Supabase/Cloudflare/Better Stack secret stores; repository values are placeholders.
- Webhooks require a shared secret and replay window; logs must not contain JWTs, cookies, API keys, IP addresses, or user identifiers.
- One Log Drain is the only fixed paid observability add-on. Cost alerts are required because Log Drain charges are outside the Supabase spend cap.

## Repository acceptance criteria

- No production config references a local path, host, launchd label, OpenClaw command, or Mac mini state.
- Concurrent duplicate alerts are serialized into one incident and one top-level delivery per channel.
- Webhook bursts are durably accepted through one ingress Durable Object and drained in bounded batches without dropping groups larger than the alert catalog.
- Recovery followed by a recurrence opens a fresh episode and sends both channels again.
- GET cannot acknowledge an incident; explicit POST, channel-specific retry ledgers, HMAC validation, and stale-timestamp rejection pass unit tests.
- Prometheus rules use labels present in the official Supabase metrics fixture; external-schema-dependent rules are explicitly marked pending and cannot be provisioned accidentally.

## Hosted production acceptance criteria

- Forced CPU, auth-volume, synthetic-failure, alert-delivery, and stale-monitor scenarios route to both channels.
- Three consecutive full drills meet the timing targets.
- End-user QA uses an actual logged-in account and validates login, data load, permissions, and recovery.
