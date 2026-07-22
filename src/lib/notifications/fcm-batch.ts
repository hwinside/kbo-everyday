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
  ok: boolean;
  lastError: string | null;
}

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-argument",
]);

/** FCM 500개 한도 청크 발송. 한 청크 throw가 앞선 성공 수를 지우지 않는다. */
export async function deliverTokenChunks(
  tokens: string[],
  sendChunk: (chunk: string[]) => Promise<FcmChunkResponse>,
  chunkSize = 500,
): Promise<TokenBatchResult> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("chunkSize must be a positive integer");
  }

  let sent = 0;
  let failed = 0;
  let ok = true;
  let lastError: string | null = null;
  const invalid: string[] = [];

  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize);
    try {
      const response = await sendChunk(chunk);
      sent += response.successCount;
      failed += response.failureCount;
      response.responses.forEach((item, index) => {
        if (INVALID_TOKEN_CODES.has(item.error?.code ?? "")) invalid.push(chunk[index]);
      });
    } catch (error) {
      ok = false;
      failed += chunk.length;
      lastError = error instanceof Error ? error.message : "fcm_chunk_exception";
    }
  }

  return { tokens: tokens.length, sent, failed, invalid, ok, lastError };
}
