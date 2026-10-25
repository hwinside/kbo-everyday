import { createHash } from "node:crypto";
import type { TokenDeliveryOutcome } from "./fcm-batch";

const FCM_CODES = new Set([
  "messaging/registration-token-not-registered", "messaging/invalid-argument",
  "messaging/internal-error", "messaging/server-unavailable", "messaging/unknown-error",
  "messaging/quota-exceeded", "messaging/message-rate-exceeded",
  "messaging/device-message-rate-exceeded", "messaging/topics-message-rate-exceeded",
  "messaging/mismatched-credential", "messaging/authentication-error",
  "messaging/third-party-auth-error", "messaging/invalid-apns-credentials",
  "messaging/sender-id-mismatch",
]);
export type WakeTarget = { user_id: string; game_id: string };
export function wakeReceipts(
  targets: WakeTarget[], devices: { user_id: string; fcm_token: string }[],
  outcomes: TokenDeliveryOutcome[], invocationId: string, attemptedAt: string,
) {
  const byToken = new Map(outcomes.map((r) => [r.token, r]));
  const seen = new Set<string>();
  return devices.flatMap((device) => targets.filter((t) => t.user_id === device.user_id).flatMap((target) => {
    const hash = createHash("sha256").update(device.fcm_token).digest("hex");
    const key = `${target.user_id}:${target.game_id}:${hash}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const result = byToken.get(device.fcm_token);
    const knownError = result?.errorCode && FCM_CODES.has(result.errorCode);
    return [{ invocation_id: invocationId, ...target, fcm_token_hash: hash,
      attempted_at: attemptedAt,
      outcome: result?.status === "accepted" ? "accepted" : knownError ? "rejected" : "unknown",
      error_code: result?.status === "accepted" ? null : knownError ? result!.errorCode : "unclassified_error",
    }];
  }));
}

/** Observability must never change delivery/claim results. No raw exception logging. */
export async function observeSafely(save: () => PromiseLike<unknown>): Promise<void> {
  try { await save(); } catch { console.warn("[live-activity] observation persistence failed"); }
}
