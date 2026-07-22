# Hosted Supabase Observability

This directory is the repository-owned control plane for production observability. Runtime execution is hosted by Grafana Cloud, Supabase, Better Stack, and Cloudflare. Nothing here depends on a developer laptop, Mac mini, launchd, OpenClaw, or a home network.

## Components

- `alert-policies.json`: canonical thresholds and expressions. Loki rules remain `schema-pending` until a real Log Drain sample confirms field names.
- `worker/`: Cloudflare Worker that validates Grafana HMAC webhooks, serializes each incident in a Durable Object, posts directly to Slack and Telegram, requires an explicit POST for ACK, and escalates after three minutes without ACK.
- `scripts/qa/observability-config-smoke.ts`: fails on missing safety rules, local-machine dependencies, duplicate IDs, or secret-like values.

## External setup order

1. Create a Grafana Cloud Free stack.
2. Enter the Supabase service-role Metrics credential directly in Grafana and install the Supabase integration with a 60-second scrape interval.
3. Install the official Supabase dashboard and translate enabled PromQL rules from `alert-policies.json` into Grafana-managed alerts.
4. Create a Grafana Cloud Loki destination, then enable exactly one Supabase Log Drain.
5. Capture one hour of actual Log Drain data and record volume. Replace `SCHEMA_PENDING` auth expressions only after verifying the actual path, status, duration, and source fields.
6. Copy `worker/wrangler.toml.example` to an untracked `wrangler.toml`, fill non-secret identifiers, and store secrets with Wrangler. The checked-in Durable Object migration creates the strongly consistent incident store.
7. Configure Grafana's webhook contact point with HMAC-SHA256, signature header `X-Grafana-Alerting-Signature`, and timestamp header `X-Grafana-Alerting-Signature-Timestamp`.
8. Configure a composite Grafana Synthetic check in two hosted regions and an independent Better Stack check.
9. Inject test alerts and complete three drills before retiring the old local health probe.

## Required secret material

Never send these values through Slack or commit them:

- Supabase service-role/secret Metrics credential entered directly into Grafana.
- Grafana HMAC secret shared only with the Worker.
- Worker ACK-link HMAC secret.
- Dedicated Slack bot token with only `chat:write`, installed only in the incident channel.
- Telegram bot token and target chat ID.
- Grafana/Loki credentials required by the Supabase Log Drain.
- Cloudflare API token limited to Workers Scripts and Durable Objects for the target account.

The recommended local handoff file is `~/.openclaw/credentials/hosted-observability.env` with mode `0600`; deployment must copy values into hosted secret stores and must not read that file at runtime.

## Cloudflare deployment

```bash
cd infra/observability/worker
cp wrangler.toml.example wrangler.toml
npx wrangler secret put GRAFANA_HMAC_SECRET
npx wrangler secret put ACK_LINK_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler deploy
```

`wrangler.toml` is environment-specific and must remain untracked. The example contains no account ID, namespace ID, channel ID, hostname, or secret.

## Grafana alert policy

- Route `critical` to the Worker immediately.
- Route `warning` to the Worker after the rule's `for` duration.
- Group by `alertname`, `severity`, and `supabase_project_ref`.
- Repeat firing notifications no more frequently than every 30 minutes; the Worker also deduplicates by Grafana fingerprint.
- Always send resolved notifications.
- Use the repository rule ID as the Grafana alert rule name.

## Cost guard

- One Log Drain only. Fixed cost is $0.0822/hour, about $60/month.
- Event cost is $0.20 per one million events plus egress and destination ingestion.
- Log Drain charges are outside the Supabase spend cap.
- During the first 24 hours, record event count and Grafana GB every hour. Alert at projected $100/month and stop for review at projected $150/month.
- Keep Grafana Free limits visible: 10,000 active metric series, 50 GB logs/month, 100,000 API synthetic executions/month. A single composite check from two locations each minute stays under the API execution limit.

## Verification

```bash
npm run qa:observability
npx eslint infra/observability/worker/src/index.ts \
  infra/observability/worker/src/index.test.ts \
  scripts/qa/observability-config-smoke.ts
```

Production PASS additionally requires:

1. bad HMAC and stale timestamps return 401;
2. a firing test reaches Slack and Telegram;
3. a duplicate fingerprint creates no new top-level incident;
4. a resolved fingerprint that fires again creates a fresh two-channel episode;
5. GET renders an ACK confirmation page without mutation and POST records ACK;
6. no ACK for three minutes creates one escalation, and partial retry targets only the missing channel;
7. a resolved event replies in the incident thread and reaches Telegram;
8. Metrics/Synthetic/Better Stack all fail when deliberately pointed at a controlled failing target;
9. an actual logged-in user completes login, authorized data load, and recovery.
