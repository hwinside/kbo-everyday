# Hosted Supabase Incident Prevention — Tasks

## Ready without external accounts

- [x] Add alert policy catalog and schema validation.
- [x] Add hosted webhook Worker with unit tests.
- [x] Add no-local-dependency and no-secret smoke tests.
- [x] Add deploy/runbook documentation and cost guardrails.

## Waiting on Harin's dad

- [x] Grafana Cloud Free stack created.
- [x] Supabase service-role Metrics credential entered directly in Grafana, never sent through Slack.
- [ ] Approval and activation of one $60/month Supabase Log Drain.
- [ ] Cloudflare Workers access and account identifier/token.
- [ ] Better Stack Free account or invitation.

## Hosted wiring

- [x] Install Grafana Supabase managed integration and official dashboard; verify live CPU, RAM, disk, and PostgreSQL status.
- [ ] Provision PromQL alerts and contact points.
- [ ] Attach Loki Log Drain, capture one-hour schema/volume sample, then provision LogQL auth alerts.
- [ ] Configure composite synthetic and independent uptime checks.
- [ ] Deploy Worker, set secrets, and verify Slack/Telegram delivery.

## Verification

- [ ] Static config and unit tests pass.
- [ ] Alert injection scenarios pass.
- [ ] Three consecutive timed drills pass.
- [ ] Actual logged-in user recovery QA passes.
- [ ] Wiki and CS knowledge are updated and audited.
