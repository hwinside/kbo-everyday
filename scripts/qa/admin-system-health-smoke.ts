import assert from "node:assert/strict";
import test from "node:test";
import { parsePrometheusText, summarizeSystemMetrics } from "../../src/lib/admin/system-health";

const sample = (overrides = "") => `
node_cpu_seconds_total{cpu="0",mode="idle"} 100
node_cpu_seconds_total{cpu="1",mode="idle"} 100
node_load1 0.8
node_memory_MemTotal_bytes 1000
node_memory_MemFree_bytes 200
node_memory_Buffers_bytes 100
node_memory_Cached_bytes 100
node_filesystem_avail_bytes{device="/dev/root",fstype="ext4",mountpoint="/"} 300
node_filesystem_size_bytes{device="/dev/root",fstype="ext4",mountpoint="/"} 1000
pg_up 1
pgbouncer_up 1
pg_stat_database_num_backends 26
pgbouncer_pools_client_active_connections{user="one"} 2
pgbouncer_pools_client_active_connections{user="two"} 3
pgbouncer_pools_client_waiting_connections 0
pg_stat_activity_xact_runtime 0.1
${overrides}
`;

test("parses labels and scientific notation", () => {
  const rows = parsePrometheusText('metric_name{mountpoint="/",device="nvme0"} 8.1e+09\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].labels.mountpoint, "/");
  assert.equal(rows[0].value, 8.1e9);
});

test("summarizes healthy server and DB metrics", () => {
  const result = summarizeSystemMetrics(sample());
  assert.equal(result.level, "healthy");
  assert.equal(result.cpuLoadPercent, 40);
  assert.equal(result.memoryUsedPercent, 60);
  assert.equal(result.diskUsedPercent, 70);
  assert.equal(result.postgresConnections, 26);
  assert.equal(result.poolActiveConnections, 5);
});

test("raises warning at resource thresholds", () => {
  const warningSample = sample()
    .replace("node_memory_MemFree_bytes 200", "node_memory_MemFree_bytes 50")
    .replace("node_memory_Buffers_bytes 100", "node_memory_Buffers_bytes 50");
  const result = summarizeSystemMetrics(warningSample);
  assert.equal(result.level, "warning");
  assert.ok(result.reasons.some((reason) => reason.startsWith("메모리")));
});

test("raises critical for DB connection waits", () => {
  const result = summarizeSystemMetrics(sample("pgbouncer_pools_client_waiting_connections{user=\"blocked\"} 2"));
  assert.equal(result.level, "critical");
  assert.ok(result.reasons.includes("DB 연결 대기 2건"));
});

test("returns unknown for malformed or empty input", () => {
  const result = summarizeSystemMetrics("# no samples\nnot valid");
  assert.equal(result.level, "unknown");
  assert.equal(result.memoryUsedPercent, null);
});
