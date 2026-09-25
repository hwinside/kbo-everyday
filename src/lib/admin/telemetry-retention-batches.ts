// Each RPC is its own transaction. Never retry a timeout/ambiguous response in
// this run: earlier successful batches remain committed and audited in the DB.
export type RetentionRpc = (
  name: string, params: Record<string, unknown>,
) => Promise<unknown>;

export async function runTelemetryRetentionBatches(
  rpc: RetentionRpc,
  backupRef: string,
  now: () => number = Date.now,
) {
  const deadline = now() + 35_000;
  const auditIds: number[] = [];
  const deleted: Record<string, number> = {};
  let phase = "raw_batch";
  const call = async (name: string, params: Record<string, unknown>) => {
    // Leave room for an 8s DB request + transport and job logging within the
    // route's 60s limit (backup lookup has a separate 8s cap).
    if (deadline - now() < 10_000) throw new Error("run budget exhausted; batches remain");
    const value = await rpc(name, params);
    if (!value || typeof value !== "object") throw new Error("invalid RPC response");
    return value as Record<string, unknown>;
  };
  const record = (value: Record<string, unknown>) => {
    if (!Number.isSafeInteger(value.auditId) || !value.deleted || typeof value.deleted !== "object") {
      throw new Error("missing committed batch audit; inspect DB before replay");
    }
    auditIds.push(value.auditId as number);
    for (const [key, count] of Object.entries(value.deleted)) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid deletion count");
      deleted[key] = (deleted[key] ?? 0) + count;
    }
  };
  try {
    // A bounded invocation may drain several days, but success is only reported
    // after the DB explicitly says raw is empty and rollup cleanup commits.
    for (let i = 0; i < 8; i += 1) {
      const batch = await call("admin_telemetry_retention_batch", {
        p_execute: true, p_backup_ref: backupRef,
      });
      if (batch.done === true) {
        phase = "rollup_cleanup";
        record(await call("admin_telemetry_retention_rollups", { p_backup_ref: backupRef }));
        return { done: true, auditIds, deleted };
      }
      if (batch.done !== false || !["pageViews", "pageDwell"].includes(String(batch.rawKind))) {
        throw new Error("invalid raw batch response");
      }
      record(batch);
    }
    throw new Error("batch limit reached; batches remain");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${phase}: ${message}; committedAudits=${JSON.stringify(auditIds)} deleted=${JSON.stringify(deleted)}; no retry`);
  }
}
