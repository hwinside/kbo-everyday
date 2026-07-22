import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const policyPath = join(root, "infra/observability/alert-policies.json");
const workerPath = join(root, "infra/observability/worker/src/index.ts");
const wranglerPath = join(root, "infra/observability/worker/wrangler.toml.example");
const policyText = readFileSync(policyPath, "utf8");
const workerText = readFileSync(workerPath, "utf8");
const wranglerText = readFileSync(wranglerPath, "utf8");
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
  "auth-user-rpm-warning",
  "auth-user-rpm-critical",
  "auth-user-errors-critical",
];

const ids = new Set(catalog.rules.map((rule) => rule.id));
for (const id of required) assert(ids.has(id), `missing rule: ${id}`);
assert.equal(ids.size, catalog.rules.length, "duplicate alert rule id");

for (const rule of catalog.rules) {
  assert(["warning", "critical"].includes(rule.severity), `${rule.id}: invalid severity`);
  assert(/^\d+[smhd]$/.test(rule.for), `${rule.id}: invalid duration`);
  assert(rule.expr.length > 10, `${rule.id}: empty expression`);
  if (rule.source === "loki") {
    assert.equal(rule.deploymentState, "schema-pending", `${rule.id}: Loki rule must wait for real drain schema`);
  }
}

for (const forbidden of ["/Users/", "/Volumes/", "launchctl", "launchd", "openclaw", "Mac mini"]) {
  assert(!combined.toLowerCase().includes(forbidden.toLowerCase()), `local dependency leaked: ${forbidden}`);
}

for (const secretPattern of [/sb_secret_[A-Za-z0-9_-]{8,}/, /xoxb-[A-Za-z0-9-]{8,}/, /bot\d+:[A-Za-z0-9_-]{8,}/]) {
  assert(!secretPattern.test(combined), `secret-like value committed: ${secretPattern}`);
}

console.log(`observability config PASS (${catalog.rules.length} alert rules)`);
