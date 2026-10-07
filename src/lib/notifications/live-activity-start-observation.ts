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
