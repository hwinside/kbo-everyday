# Hosted Supabase Incident Prevention — Plan

## Slice 1: repository-owned control plane

- Add a vendor-neutral alert policy catalog with PromQL/LogQL expressions and thresholds.
- Add a Cloudflare Worker webhook receiver with authentication, replay protection, per-incident Durable Object serialization, Slack delivery, and Telegram delivery.
- Add configuration smoke tests that reject local-machine dependencies and secret material.
- Document required hosted accounts, credentials, deploy order, rollback, and cost guards.

## Slice 2: hosted service wiring

- Install the managed Supabase integration in Grafana Cloud using a service-role Metrics credential entered directly in Grafana.
- Install the official Supabase dashboard and provision the repository alert catalog.
- Configure one Supabase Log Drain to Grafana Cloud Loki and validate the real log schema before enabling auth LogQL alerts.
- Configure a two-location composite synthetic check plus an independent Better Stack check.
- Deploy the Worker and set contact points for Slack and Telegram.

## Slice 3: reversible mitigation

- Add a hosted incident-mode store with a short TTL.
- Wire only non-critical Realtime/polling/cron paths to bounded load-shed decisions.
- Keep restart, resize, and PITR as human-approved runbook actions.

## Slice 4: verification and handoff

- Inject test alerts without stressing production.
- Run controlled game-peak load and auth-amplification tests.
- Verify alert delivery, acknowledgement escalation, recovery, and actual-user E2E three times.
- Update runbook, postmortem, infrastructure map, cron inventory, cost structure, and CS knowledge.

## Rollback

- Disable Grafana contact points and synthetic checks.
- Disable the Supabase Log Drain to stop hourly/event billing.
- Delete or disable the Cloudflare Worker route. Its incident Durable Objects then become unreachable.
- Load-shed flags expire automatically; no rollback requires a database restore.
