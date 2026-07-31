export const BASEBALL_QA_OUTBOX_KEY = "baseball-genius-question-outbox-v1";
export const BASEBALL_QA_MAX_ATTEMPTS = 5;

export interface BaseballQaOutboxEntry {
  conversationId: string;
  messageId: number;
  attempts: number;
  acknowledged?: boolean;
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

export type BaseballQaReplyState = "waiting" | "retrying" | "failed";
export type BaseballQaReplyStates = Record<number, BaseballQaReplyState>;

interface BaseballQaReplyMessage {
  sender_id: string | null;
  dedup_key?: string | null;
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
        row.attempts >= 0 &&
        (row.acknowledged === undefined || typeof row.acknowledged === "boolean"),
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
    row.messageId === messageId ? { ...row, attempts: 0, acknowledged: false } : row,
  );
  writeBaseballQaOutbox(storage, entries);
}

export function getBaseballQaReplyStates(
  entries: BaseballQaOutboxEntry[],
  retryingMessageIds: ReadonlySet<number> = new Set(),
): BaseballQaReplyStates {
  return Object.fromEntries(entries.map((entry) => [
    entry.messageId,
    entry.attempts >= BASEBALL_QA_MAX_ATTEMPTS
      ? "failed"
      : retryingMessageIds.has(entry.messageId)
        ? "retrying"
        : "waiting",
  ]));
}

export function observeBaseballQaReplies(
  storage: StorageLike,
  messages: BaseballQaReplyMessage[],
  geniusUserId: string,
): number[] {
  const observed = new Set<number>();
  for (const message of messages) {
    if (message.sender_id !== geniusUserId) continue;
    const match = /^baseball-genius:(\d+)$/.exec(message.dedup_key ?? "");
    if (!match) continue;
    const messageId = Number(match[1]);
    if (Number.isSafeInteger(messageId) && messageId > 0) observed.add(messageId);
  }
  if (observed.size === 0) return [];

  const entries = readBaseballQaOutbox(storage);
  const completed = entries
    .filter((entry) => observed.has(entry.messageId))
    .map((entry) => entry.messageId);
  if (completed.length > 0) {
    writeBaseballQaOutbox(
      storage,
      entries.filter((entry) => !observed.has(entry.messageId)),
    );
  }
  return Array.from(observed);
}

export async function attemptBaseballQaOutbox(
  storage: StorageLike,
  accessToken: string | null,
  request: typeof fetch = fetch,
): Promise<BaseballQaAttemptResult> {
  const entries = readBaseballQaOutbox(storage);
  const result: BaseballQaAttemptResult = { completed: [], pending: [], failed: [] };
  const updates = new Map<number, BaseballQaOutboxEntry>();

  for (const entry of entries) {
    if (entry.acknowledged) {
      updates.set(entry.messageId, entry);
      result.pending.push(entry.messageId);
      continue;
    }
    if (entry.attempts >= BASEBALL_QA_MAX_ATTEMPTS) {
      updates.set(entry.messageId, entry);
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
        updates.set(entry.messageId, { ...entry, acknowledged: true });
        result.completed.push(entry.messageId);
        continue;
      }
      if (response.status === 202) {
        updates.set(entry.messageId, entry);
        result.pending.push(entry.messageId);
        continue;
      }
    } catch {
      // DM 질문은 이미 저장되어 있다. 동일 messageId만 재시도한다.
    }

    const next = { ...entry, attempts: entry.attempts + 1 };
    updates.set(entry.messageId, next);
    if (next.attempts >= BASEBALL_QA_MAX_ATTEMPTS) result.failed.push(entry.messageId);
    else result.pending.push(entry.messageId);
  }

  // 요청 중 exact 답변이 관측되어 제거된 항목은 되살리지 않고,
  // 같은 사이 새로 enqueue 된 질문은 보존한다.
  const current = readBaseballQaOutbox(storage);
  writeBaseballQaOutbox(
    storage,
    current.map((entry) => updates.get(entry.messageId) ?? entry),
  );
  return result;
}
