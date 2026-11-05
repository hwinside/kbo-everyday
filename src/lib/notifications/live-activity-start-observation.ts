import { createHash, randomUUID } from "node:crypto";
import type { ApnsResult } from "./apns";

const APNS_REASONS = new Set([
  "BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "BadTopic",
  "TopicDisallowed", "PayloadEmpty", "PayloadTooLarge", "BadPriority",
  "BadExpirationDate", "BadCollapseId", "BadMessageId", "BadPath",
  "ExpiredProviderToken", "InvalidProviderToken", "MissingProviderToken",
  "Forbidden", "TooManyRequests", "TooManyProviderTokenUpdates",
  "InternalServerError", "ServiceUnavailable", "Shutdown", "timeout",
  "BadPushType", "MissingTopic", "DuplicateHeaders", "MethodNotAllowed",
  "IdleTimeout",
]);

type Context = {
  gameId: string; userId: string; pushToken: string;
  env: "production" | "sandbox"; channelId?: string;
};

/** Diagnostic logs only: neither a durable delivery ledger nor permission to retry.
 * An attempted event without a result remains unknown (including process cutoff
 * or log loss). APNs accepted means server acceptance, never device display.
 */
export async function observeStartAttempt(
  context: Context,
  send: () => Promise<ApnsResult>,
  emit: (record: Record<string, unknown>) => void = record =>
    console.info("[live-activity] start-attempt", JSON.stringify(record)),
): Promise<ApnsResult> {
  const started = Date.now();
  const base = {
    attemptId: randomUUID(), gameId: context.gameId, userId: context.userId,
    deviceKey: createHash("sha256").update(context.pushToken).digest("hex"),
    env: context.env, channelId: context.channelId ?? null,
  };
  // Observability must not change the existing send/result/retry contract.
  const log = (fields: Record<string, unknown>) => {
    try { emit({ ...base, at: new Date().toISOString(), ...fields }); } catch { /* best effort */ }
  };
  log({ phase: "attempted" });
  let result: ApnsResult;
  try { result = await send(); }
  catch (error) {
    log({ phase: "response_unknown", reason: "send_threw", elapsedMs: Date.now() - started });
    throw error;
  }
  log({
    phase: result.ok ? "accepted" : result.status > 0 ? "rejected" : "response_unknown",
    status: result.status, invalidToken: result.invalidToken,
    // Never log raw transport messages, which can include URLs/device tokens.
    reason: result.reason && APNS_REASONS.has(result.reason)
      ? result.reason : result.reason ? "unclassified_error" : null,
    apnsId: result.apnsId && /^[0-9a-f-]{36}$/i.test(result.apnsId) ? result.apnsId : null,
    elapsedMs: Date.now() - started,
  });
  return result;
}

/** One synchronous send-chunk wave, then (if needed) its fallback wave.
 * Publish attempts BEFORE releasing any send. Publish results before resolving
 * callers, so sandbox retries form a separate bounded wave, not per-device logs.
 * A cutoff leaves attempts without results: unknown, never permission to retry.
 */
export function createStartAttemptBatch(
  emit: (line: string) => void = line => console.info(line),
) {
  type Job = { context: Context; send: () => Promise<ApnsResult>;
    resolve: (result: ApnsResult) => void; reject: (error: unknown) => void };
  let pending: Job[] = [];
  const publish = (value: unknown) => {
    try { emit('[live-activity] start-batch ' + JSON.stringify(value)); } catch { /* best effort */ }
  };
  const drain = async () => {
    const jobs = pending;
    pending = [];
    const batchId = randomUUID();
    const attempts: Record<string, unknown>[] = [];
    const results: Record<string, unknown>[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sends = jobs.map(job => observeStartAttempt(job.context,
      async () => { await gate; return job.send(); },
      record => { (record.phase === 'attempted' ? attempts : results).push(record); }));
    const contexts: unknown[][] = [];
    const rows = attempts.map(record => {
      const context = [record.gameId, record.env, record.channelId];
      let index = contexts.findIndex(value => JSON.stringify(value) === JSON.stringify(context));
      if (index < 0) { index = contexts.length; contexts.push(context); }
      return [record.userId, record.deviceKey, index];
    });
    // v1: attempts row index is the result correlation key within batchId.
    publish({ v: 1, batchId, phase: 'attempted', at: new Date().toISOString(),
      contextColumns: ['gameId', 'env', 'channelId'], contexts,
      columns: ['userId', 'deviceKey', 'contextIndex'], rows });
    release();
    const settled = await Promise.allSettled(sends);
    publish({ v: 1, batchId, phase: 'results', at: new Date().toISOString(),
      columns: ['attemptIndex', 'phase', 'status', 'invalidToken', 'reason', 'apnsId', 'elapsedMs'],
      rows: results.map(record => [attempts.findIndex(a => a.attemptId === record.attemptId),
        record.phase, record.status ?? null, record.invalidToken ?? null,
        record.reason, record.apnsId ?? null, record.elapsedMs]) });
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') jobs[index].resolve(result.value);
      else jobs[index].reject(result.reason);
    });
  };
  return (context: Context, send: () => Promise<ApnsResult>): Promise<ApnsResult> =>
    new Promise((resolve, reject) => {
      pending.push({ context, send, resolve, reject });
      if (pending.length === 1) queueMicrotask(() => { void drain(); });
    });
}
