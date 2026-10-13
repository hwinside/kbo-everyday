import assert from "node:assert/strict";
import { runTelemetryRetentionBatches } from "../../src/lib/admin/telemetry-retention-batches";

async function main() {
  const calls: string[] = [];
  const queue = [
    { done: false, rawKind: "pageViews", auditId: 1, deleted: { pageViews: 163434 } },
    { done: false, rawKind: "pageDwell", auditId: 2, deleted: { pageDwell: 145590 } },
    { done: true }, { auditId: 3, deleted: { dwellSessions: 0 } },
  ];
  const result = await runTelemetryRetentionBatches(async name => { calls.push(name); return queue.shift(); }, "backup");
  assert.equal(calls.length,4);
  assert.equal(calls[3], "admin_telemetry_retention_rollups");
  assert.deepEqual(result.auditIds,[1,2,3]);
  assert.equal(result.deleted.pageViews,163434);
  let attempts = 0;
  await assert.rejects(runTelemetryRetentionBatches(async () => {
    attempts++;
    if (attempts === 1) return {done:false,rawKind:"pageViews",auditId:7,deleted:{pageViews:10}};
    throw new Error("canceling statement code=57014");
  }, "backup"), /committedAudits=\[7\].*no retry/);
  assert.equal(attempts,2,"timeout must not retry or call rollup cleanup");
  let clock = 0, budgetCalls = 0;
  await assert.rejects(runTelemetryRetentionBatches(async () => {
    budgetCalls++; clock += 30_000;
    return {done:false,rawKind:"pageViews",auditId:8,deleted:{pageViews:10}};
  }, "backup",()=>clock), /budget exhausted/);
  assert.equal(budgetCalls,1);
  const limitCalls: string[] = [];
  await assert.rejects(runTelemetryRetentionBatches(async name => {
    limitCalls.push(name);
    return {done:false,rawKind:"pageViews",auditId:limitCalls.length,deleted:{pageViews:10}};
  }, "backup", () => 0), /batch limit reached; batches remain; committedAudits=\[1,2,3,4,5,6,7,8\].*no retry/);
  assert.equal(limitCalls.length,8,"call cap must fail even with time remaining");
  assert.ok(limitCalls.every(name => name === "admin_telemetry_retention_batch"),
    "unfinished raw must never call rollup cleanup");
  let invalidCalls = 0;
  await assert.rejects(runTelemetryRetentionBatches(async () => { invalidCalls++; return null; },"backup"), /invalid RPC response/);
  assert.equal(invalidCalls,1);
  console.log("PASS batch runner: explicit done, independent commits, timeout/no retry, budget, malformed response");
}
main().catch(error => { console.error(error); process.exitCode=1; });
