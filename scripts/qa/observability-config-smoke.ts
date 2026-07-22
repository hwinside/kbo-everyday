import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const policyPath = join(root, "infra/observability/alert-policies.json");
const workerPath = join(root, "infra/observability/worker/src/index.ts");
const wranglerPath = join(root, "infra/observability/worker/wrangler.toml.example");
const fixturePath = join(root, "infra/observability/fixtures/supabase-metrics.prom");
const policyText = readFileSync(policyPath, "utf8");
const workerText = readFileSync(workerPath, "utf8");
const wranglerText = readFileSync(wranglerPath, "utf8");
const fixtureText = readFileSync(fixturePath, "utf8");
const combined = `${policyText}\n${workerText}\n${wranglerText}`;
const catalog = JSON.parse(policyText) as {
  rules: Array<{ id: string; source: string; severity: string; for: string; expr: string; deploymentState?: string }>;
};

const required = [
  "supabase-cpu-warning",
  "supabase-cpu-critical",
  "supabase-memory-critical",
  "supabase-disk-critical",
  "supabase-disk-exhaustion-forecast",
  "supabase-disk-io-critical",
  "supabase-database-down",
  "supabase-client-waiting",
  "supabase-metrics-stale",
  "supabase-swap-warning",
  "supabase-active-connection-ratio-warning",
  "supabase-long-transaction-critical",
  "supabase-realtime-lag-critical",
  "auth-user-rpm-warning",
  "auth-user-rpm-critical",
  "auth-user-errors-critical",
  "auth-user-p95-critical",
  "auth-user-4xx-warning",
  "synthetic-auth-journey-critical",
  "alert-path-heartbeat-stale",
];

const ids = new Set(catalog.rules.map((rule) => rule.id));
for (const id of required) assert(ids.has(id), `missing rule: ${id}`);
assert.equal(ids.size, catalog.rules.length, "duplicate alert rule id");

for (const rule of catalog.rules) {
  assert(["warning", "critical"].includes(rule.severity), `${rule.id}: invalid severity`);
  assert(/^\d+[smhd]$/.test(rule.for), `${rule.id}: invalid duration`);
  assert(rule.expr.length > 10, `${rule.id}: empty expression`);
  if (rule.deploymentState) {
    assert(
      ["schema-pending", "capacity-label-pending", "query-exporter-pending", "provider-pending"].includes(rule.deploymentState),
      `${rule.id}: unknown deployment state`,
    );
    assert(rule.expr.startsWith("SCHEMA_PENDING:"), `${rule.id}: pending rule must not look deployable`);
  }
}

const diskRules = catalog.rules.filter((rule) => rule.id.startsWith("supabase-disk-") && rule.id !== "supabase-disk-io-critical");
assert.equal(diskRules.length, 3, "expected three filesystem disk rules");
assert(fixtureText.includes('fstype="ext4",mountpoint="/"'), "official filesystem fixture missing root mount labels");
for (const rule of diskRules) {
  assert(rule.expr.includes('mountpoint="/"'), `${rule.id}: must target the official root mount`);
  assert(rule.expr.includes('fstype!="rootfs"'), `${rule.id}: must exclude rootfs pseudo-filesystems`);
  assert(!rule.expr.includes('mountpoint="/data"'), `${rule.id}: stale /data selector`);
}

assert(wranglerText.includes('class_name = "IncidentCoordinator"'), "Durable Object binding missing");
assert(!wranglerText.includes("kv_namespaces"), "eventually-consistent KV must not own incident state");

for (const forbidden of ["/Users/", "/Volumes/", "launchctl", "launchd", "openclaw", "Mac mini"]) {
  assert(!combined.toLowerCase().includes(forbidden.toLowerCase()), `local dependency leaked: ${forbidden}`);
}

for (const secretPattern of [/sb_secret_[A-Za-z0-9_-]{8,}/, /xoxb-[A-Za-z0-9-]{8,}/, /bot\d+:[A-Za-z0-9_-]{8,}/]) {
  assert(!secretPattern.test(combined), `secret-like value committed: ${secretPattern}`);
}

console.log(`observability config PASS (${catalog.rules.length} alert rules)`);
