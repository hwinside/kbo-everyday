export const BASEBALL_QA_OUTBOX_KEY = "baseball-genius-question-outbox-v1";
export const BASEBALL_QA_MAX_ATTEMPTS = 5;

export interface BaseballQaOutboxEntry {
  conversationId: string;
  messageId: number;
  attempts: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BaseballQaAttemptResult {
  completed: number[];
  pending: number[];
  failed: number[];
}

export function readBaseballQaOutbox(storage: StorageLike): BaseballQaOutboxEntry[] {
  try {
    const value = JSON.parse(storage.getItem(BASEBALL_QA_OUTBOX_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (row): row is BaseballQaOutboxEntry =>
        row &&
        typeof row.conversationId === "string" &&
        Number.isSafeInteger(row.messageId) &&
        row.messageId > 0 &&
        Number.isInteger(row.attempts) &&
        row.attempts >= 0,
    );
  } catch {
    return [];
  }
}

function writeBaseballQaOutbox(storage: StorageLike, entries: BaseballQaOutboxEntry[]) {
  storage.setItem(BASEBALL_QA_OUTBOX_KEY, JSON.stringify(entries));
}

export function enqueueBaseballQaQuestion(
  storage: StorageLike,
  entry: Omit<BaseballQaOutboxEntry, "attempts">,
) {
  const entries = readBaseballQaOutbox(storage);
  if (!entries.some((row) => row.messageId === entry.messageId)) {
    entries.push({ ...entry, attempts: 0 });
    writeBaseballQaOutbox(storage, entries);
  }
}

export function resetBaseballQaQuestion(storage: StorageLike, messageId: number) {
  const entries = readBaseballQaOutbox(storage).map((row) =>
    row.messageId === messageId ? { ...row, attempts: 0 } : row,
  );
  writeBaseballQaOutbox(storage, entries);
}

export async function attemptBaseballQaOutbox(
  storage: StorageLike,
  accessToken: string | null,
  request: typeof fetch = fetch,
): Promise<BaseballQaAttemptResult> {
  const entries = readBaseballQaOutbox(storage);
  const result: BaseballQaAttemptResult = { completed: [], pending: [], failed: [] };
  const keep: BaseballQaOutboxEntry[] = [];

  for (const entry of entries) {
    if (entry.attempts >= BASEBALL_QA_MAX_ATTEMPTS) {
      keep.push(entry);
      result.failed.push(entry.messageId);
      continue;
    }
    try {
      const response = await request("/api/baseball-qa", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          conversationId: entry.conversationId,
          messageId: entry.messageId,
        }),
      });
      if (response.ok && response.status !== 202) {
        result.completed.push(entry.messageId);
        continue;
      }
      if (response.status === 202) {
        keep.push(entry);
        result.pending.push(entry.messageId);
        continue;
      }
    } catch {
      // DM 질문은 이미 저장되어 있다. 동일 messageId만 재시도한다.
    }

    const next = { ...entry, attempts: entry.attempts + 1 };
    keep.push(next);
    if (next.attempts >= BASEBALL_QA_MAX_ATTEMPTS) result.failed.push(entry.messageId);
    else result.pending.push(entry.messageId);
  }

  writeBaseballQaOutbox(storage, keep);
  return result;
}
