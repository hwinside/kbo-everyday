import type { ApnsResult } from "./apns";

const REASONS = new Set([
  "BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "BadTopic",
  "TopicDisallowed", "PayloadEmpty", "PayloadTooLarge", "BadPriority",
  "BadExpirationDate", "BadCollapseId", "BadMessageId", "BadPath",
  "ExpiredProviderToken", "InvalidProviderToken", "MissingProviderToken",
  "Forbidden", "TooManyRequests", "TooManyProviderTokenUpdates",
  "InternalServerError", "ServiceUnavailable", "Shutdown", "timeout",
  "BadPushType", "MissingTopic", "DuplicateHeaders", "MethodNotAllowed", "IdleTimeout",
]);

export type RecoveryReceipt = {
  restart_apns_outcome: "accepted" | "rejected" | "unknown";
  restart_apns_status: number;
  restart_apns_reason: string | null;
  restart_apns_id: string | null;
  restart_apns_recorded_at: string;
};

/** Receipt only. Never releases a claim, retries a push, or marks a device ACK.
 * A cutoff/persist failure leaves NULL (unknown); a transport failure is unknown,
 * not Apple rejection. Raw transport errors may contain tokens: never persist them.
 */
export async function sendRecoveryWithReceipt(
  send: () => Promise<ApnsResult>,
  persist: (receipt: RecoveryReceipt) => Promise<void>,
  warn: () => void = () => console.error("[live-activity] recovery receipt persistence failed"),
): Promise<ApnsResult> {
  const save = async (result?: ApnsResult) => {
    const status = result && Number.isInteger(result.status) && result.status >= 100 && result.status <= 599
      ? result.status : 0;
    const receipt: RecoveryReceipt = {
      restart_apns_outcome: status === 200 && result?.ok ? "accepted" : status > 0 ? "rejected" : "unknown",
      restart_apns_status: status,
      restart_apns_reason: !result ? "send_threw" : result.reason
        ? REASONS.has(result.reason) ? result.reason : "unclassified_error" : null,
      restart_apns_id: result?.apnsId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.apnsId)
        ? result.apnsId : null,
      restart_apns_recorded_at: new Date().toISOString(),
    };
    try { await persist(receipt); } catch { try { warn(); } catch { /* diagnostic only */ } }
  };
  let result: ApnsResult;
  try { result = await send(); } catch (error) { await save(); throw error; }
  await save(result);
  return result;
}
