export interface FcmChunkResponse {
  successCount: number;
  failureCount: number;
  responses: Array<{ error?: { code?: string } }>;
}

export interface TokenBatchResult {
  tokens: number;
  sent: number;
  failed: number;
  invalid: string[];
  /** 다음 fast tick에서 재시도해야 하는 transient/미시도 토큰 수. */
  retryableFailed: number;
  ok: boolean;
  lastError: string | null;
  outcomes: TokenDeliveryOutcome[];
}

export type TokenDeliveryOutcome = {
  token: string;
  status: "accepted" | "transient" | "invalid" | "permanent_failed";
  errorCode: string | null;
};

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-argument",
]);

const TRANSIENT_TOKEN_CODES = new Set([
  "messaging/internal-error",
  "messaging/server-unavailable",
  "messaging/unknown-error",
  "messaging/quota-exceeded",
  "messaging/message-rate-exceeded",
  "messaging/device-message-rate-exceeded",
  "messaging/topics-message-rate-exceeded",
]);

/** FCM 500개 한도 청크 발송. 한 청크 throw가 앞선 성공 수를 지우지 않는다. */
export async function deliverTokenChunks(
  tokens: string[],
  sendChunk: (chunk: string[]) => Promise<FcmChunkResponse>,
  chunkSize = 500,
  opts?: { deadlineAtMs?: number; now?: () => number; concurrency?: number },
): Promise<TokenBatchResult> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("chunkSize must be a positive integer");
  }

  const concurrency = opts?.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new Error("concurrency must be an integer between 1 and 5");
  }
  let sent = 0;
  let failed = 0;
  let ok = true;
  let retryableFailed = 0;
  let lastError: string | null = null;
  const invalid: string[] = [];
  const outcomes: TokenDeliveryOutcome[] = [];
  const now = opts?.now ?? Date.now;

  // Bounded waves: preserve input order when aggregating, regardless of completion order.
  for (let start = 0; start < tokens.length; start += chunkSize * concurrency) {
    const chunks: string[][] = [];
    for (let i = start; i < Math.min(tokens.length, start + chunkSize * concurrency); i += chunkSize) {
      chunks.push(tokens.slice(i, i + chunkSize));
    }
    const results = await Promise.all(chunks.map(async (chunk) => {
      // Check immediately before EACH launch, including within a wave.
      if (opts?.deadlineAtMs != null && now() >= opts.deadlineAtMs) {
        return { error: new Error("deadline_exceeded") };
      }
      try {
        return { response: await sendChunk(chunk) };
      } catch (error) {
        return { error };
      }
    }));
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const result = results[index];
      try {
        if ("error" in result) throw result.error;
        const response = result.response;
        sent += response.successCount;
        failed += response.failureCount;
        response.responses.forEach((item, index) => {
          const code = item.error?.code ?? "";
          if (!code) {
            outcomes.push({ token: chunk[index], status: "accepted", errorCode: null });
          } else if (INVALID_TOKEN_CODES.has(code)) {
            invalid.push(chunk[index]);
            outcomes.push({ token: chunk[index], status: "invalid", errorCode: code });
          } else if (TRANSIENT_TOKEN_CODES.has(code)) {
            retryableFailed += 1;
            outcomes.push({ token: chunk[index], status: "transient", errorCode: code });
          } else {
            outcomes.push({ token: chunk[index], status: "permanent_failed", errorCode: code });
          }
        });
      } catch (error) {
        ok = false;
        failed += chunk.length;
        retryableFailed += chunk.length;
        lastError = error instanceof Error ? error.message : "fcm_chunk_exception";
        for (const token of chunk) {
          outcomes.push({ token, status: "transient", errorCode: lastError });
        }
      }
    }
  }

  return { tokens: tokens.length, sent, failed, invalid, retryableFailed, ok, lastError, outcomes };
}
