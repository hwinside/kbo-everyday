import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const policyPath = join(root, "infra/observability/alert-policies.json");
const workerPath = join(root, "infra/observability/worker/src/index.ts");
const wranglerPath = join(root, "infra/observability/worker/wrangler.toml.example");
const fixturePath = join(root, "infra/observability/fixtures/supabase-metrics.prom");
const inventoryPath = join(root, "infra/observability/fixtures/live-metric-inventory.txt");
const policyText = readFileSync(policyPath, "utf8");
const workerText = readFileSync(workerPath, "utf8");
const wranglerText = readFileSync(wranglerPath, "utf8");
const fixtureText = readFileSync(fixturePath, "utf8");
const inventoryText = readFileSync(inventoryPath, "utf8");
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
  "supabase-pool-client-maxwait-critical",
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
assert(wranglerText.includes('class_name = "AlertIngressCoordinator"'), "durable ingress queue binding missing");
assert(!wranglerText.includes("kv_namespaces"), "eventually-consistent KV must not own incident state");

for (const forbidden of ["/Users/", "/Volumes/", "launchctl", "launchd", "openclaw", "Mac mini"]) {
  assert(!combined.toLowerCase().includes(forbidden.toLowerCase()), `local dependency leaked: ${forbidden}`);
}

for (const secretPattern of [/sb_secret_[A-Za-z0-9_-]{8,}/, /xoxb-[A-Za-z0-9-]{8,}/, /bot\d+:[A-Za-z0-9_-]{8,}/]) {
  assert(!secretPattern.test(combined), `secret-like value committed: ${secretPattern}`);
}

// --- Live metric inventory regression -------------------------------------
// Every deployable ("ready") prometheus rule must only reference metrics that
// actually exist in the hosted scrape. This catches phantom metrics such as the
// removed `supavisor_pool_checkout_duration_local_bucket`, which produced a
// rule that could never fire.
const inventory = new Set(
  inventoryText
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0),
);
assert(inventory.size > 0, "live metric inventory is empty");

// PromQL functions/keywords that appear as bare identifiers outside label
// matchers and must not be treated as metric names.
const promKeywords = new Set([
  "sum", "rate", "irate", "avg", "min", "max", "count", "count_values", "stddev",
  "stdvar", "group", "clamp", "clamp_min", "clamp_max", "predict_linear", "deriv",
  "delta", "idelta", "increase", "absent", "absent_over_time", "avg_over_time",
  "max_over_time", "min_over_time", "sum_over_time", "last_over_time",
  "present_over_time", "count_over_time", "quantile_over_time", "histogram_quantile",
  "quantile", "topk", "bottomk", "ceil", "floor", "round", "abs", "sqrt", "exp",
  "ln", "log2", "log10", "by", "without", "on", "ignoring", "group_left",
  "group_right", "and", "or", "unless", "offset", "bool", "inf", "nan", "time",
]);

function extractMetricNames(expr: string): string[] {
  // Strip label matchers {...}, range/subquery selectors [...], and string
  // literals so only metric names and function identifiers remain.
  const stripped = expr
    // Strip string literals first: label values like "${SUPABASE_PROJECT_REF}"
    // contain braces that would otherwise truncate the {...} matcher strip.
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    // Drop label-name lists in grouping clauses (by/without/on/ignoring/...).
    .replace(
      /\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g,
      " ",
    );
  const tokens = stripped.match(/[A-Za-z_:][A-Za-z0-9_:]*/g) ?? [];
  return tokens.filter((token) => {
    if (promKeywords.has(token)) return false;
    // Duration/number suffixes like 5m, 3600 never survive as identifiers here.
    return true;
  });
}

const readyPrometheusRules = catalog.rules.filter(
  (rule) => rule.source === "prometheus" && !rule.deploymentState,
);
assert(readyPrometheusRules.length > 0, "expected at least one ready prometheus rule");

for (const rule of readyPrometheusRules) {
  assert(
    !rule.expr.startsWith("SCHEMA_PENDING:"),
    `${rule.id}: ready rule must have a concrete expression`,
  );
  for (const metric of extractMetricNames(rule.expr)) {
    assert(
      inventory.has(metric),
      `${rule.id}: references metric '${metric}' absent from live inventory`,
    );
  }
}

// Explicit guard: the phantom pool-checkout metric must never return.
assert(
  !combined.includes("supavisor_pool_checkout_duration_local_bucket"),
  "phantom metric supavisor_pool_checkout_duration_local_bucket reintroduced",
);

console.log(
  `observability config PASS (${catalog.rules.length} alert rules, ` +
    `${readyPrometheusRules.length} ready prometheus rules validated against ` +
    `${inventory.size}-metric live inventory)`,
);
