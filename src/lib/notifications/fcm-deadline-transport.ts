import type { FcmChunkResponse } from "@/lib/notifications/fcm-batch";
import { runBeforeDeadline } from "@/lib/async-deadline";

export interface DeadlineFcmMessage {
  notification?: { title: string; body: string };
  data?: Record<string, string>;
  android?: {
    priority?: "HIGH" | "NORMAL";
    collapse_key?: string;
    ttl?: string;
    notification?: { tag: string };
  };
  apns?: {
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
  };
}

interface DeadlineFcmDeps {
  projectId: string;
  getAccessToken(): Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function messagingCode(payload: unknown): string {
  const error = (payload as { error?: { status?: string; details?: Array<{ errorCode?: string }> } })?.error;
  const raw = error?.details?.find((detail) => typeof detail.errorCode === "string")?.errorCode
    ?? error?.status
    ?? "UNKNOWN";
  switch (raw) {
    case "UNREGISTERED": return "messaging/registration-token-not-registered";
    case "INVALID_ARGUMENT": return "messaging/invalid-argument";
    case "QUOTA_EXCEEDED": return "messaging/quota-exceeded";
    case "UNAVAILABLE": return "messaging/server-unavailable";
    case "INTERNAL": return "messaging/internal-error";
    default: return "messaging/unknown-error";
  }
}

/**
 * FCM HTTP v1 transport used only by deadline-bound fast-refresh sends.
 * Firebase Admin's multicast API has a fixed 15s timeout but no AbortSignal, so racing its
 * Promise can return while the request keeps transmitting. Native fetch gives this path a
 * real cancellation boundary: the function returns only after every started request has
 * either completed or observed the shared abort signal.
 */
export async function sendDeadlineFcmChunk(
  tokens: string[],
  message: DeadlineFcmMessage,
  deadlineAtMs: number,
  deps: DeadlineFcmDeps,
): Promise<FcmChunkResponse> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const accessToken = await runBeforeDeadline(deps.getAccessToken, deadlineAtMs, now);
  const remainingMs = deadlineAtMs - now();
  if (remainingMs <= 0) throw new Error("deadline_exceeded");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(deps.projectId)}/messages:send`;
  try {
    const responses = await Promise.all(tokens.map(async (token) => {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ message: { ...message, token } }),
          signal: controller.signal,
        });
        if (response.ok) return {};
        const payload = await response.json().catch(() => null);
        return { error: { code: messagingCode(payload) } };
      } catch {
        return { error: { code: "messaging/server-unavailable" } };
      }
    }));
    const failureCount = responses.filter((response) => response.error != null).length;
    return {
      successCount: responses.length - failureCount,
      failureCount,
      responses,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
