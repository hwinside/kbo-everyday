export const BASEBALL_QA_OUTBOX_KEY = "baseball-genius-question-outbox-v1";
export const BASEBALL_QA_MAX_ATTEMPTS = 5;

export interface BaseballQaOutboxEntry {
  conversationId: string;
  messageId: number;
  attempts: number;
  acknowledged?: boolean;
  /** picker DM을 관측해 사용자 선택만 기다리는 상태. typing indicator/retry는 멈춘다. */
  awaitingPlayerPick?: boolean;
  /**
   * 동명이인 picker에서 유저가 고른 kboId. 재시도해도 같은 선수로 답하도록 outbox에 같이
   * 보관한다 — 버리면 재시도 때 picker가 다시 뜨면서 유저 선택이 사라진다.
   */
  pickedPlayerKboId?: string;
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
  payload?: unknown;
}

function isPickerReply(message: BaseballQaReplyMessage): boolean {
  if (message.dedup_key?.startsWith("baseball-genius-picker:")) return true;
  if (!message.payload || typeof message.payload !== "object") return false;
  return (message.payload as { reply_kind?: unknown }).reply_kind === "picker";
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
        (row.acknowledged === undefined || typeof row.acknowledged === "boolean") &&
        (row.awaitingPlayerPick === undefined || typeof row.awaitingPlayerPick === "boolean") &&
        (row.pickedPlayerKboId === undefined ||
          (typeof row.pickedPlayerKboId === "string" && row.pickedPlayerKboId.length > 0)),
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

/**
 * 동명이인 picker 선택을 기존 항목에 붙이고 재시도할 수 있게 되돌린다.
 *
 * 새 질문 메시지를 만들지 않고 **원래 질문 messageId 그대로** 재처리한다. 새 메시지를
 * 만들면 quota가 또 예약되고 대화창에 같은 질문이 두 번 남는다.
 */
export function applyBaseballQaPlayerPick(
  storage: StorageLike,
  conversationId: string,
  messageId: number,
  pickedPlayerKboId: string,
  /**
   * 이미 최종 답변(`baseball-genius:{id}`)이 있는 질문인가.
   *
   * 진짜면 서버는 dedup으로 200만 돌려주고 새 DM을 만들지 않는다. 그런데도 outbox에
   * 항목을 넣으면 `acknowledged=true`로 남아 typing indicator가 영원히 돌고, 관측할 새
   * 메시지가 없어 지워지지도 않는다. 과거 picker 카드 재탭은 여기서 아예 막는다.
   */
  alreadyAnswered = false,
): boolean {
  if (alreadyAnswered) return false;
  const entries = readBaseballQaOutbox(storage);
  const index = entries.findIndex((row) => row.messageId === messageId);
  const selected: BaseballQaOutboxEntry = {
    conversationId,
    messageId,
    pickedPlayerKboId,
    attempts: 0,
    acknowledged: false,
    awaitingPlayerPick: false,
  };
  if (index >= 0) entries[index] = { ...entries[index], ...selected };
  else entries.push(selected);
  // 서버의 durable picker DM이 정본이다. localStorage가 비었거나 다른 기기여도
  // conversationId + question_message_id로 항목을 복원해 선택 요청을 1회 만든다.
  writeBaseballQaOutbox(storage, entries);
  return true;
}

/**
 * 최종 답변이 이미 도착한 질문 messageId 집합.
 *
 * picker 카드는 답변 뒤에도 히스토리에 그대로 남아 있다. 이 집합으로 UI를 비활성화하고
 * 선택 요청 자체를 막는다 — 판정 규칙은 outbox 관측과 같은 모듈에 둔다(두 곳으로 갈라지면 어깋난다).
 */
export function collectBaseballQaAnsweredQuestionIds(
  messages: BaseballQaReplyMessage[],
  geniusUserId: string,
): Set<number> {
  const answered = new Set<number>();
  for (const message of messages) {
    if (message.sender_id !== geniusUserId) continue;
    const match = /^baseball-genius:(\d+)$/.exec(message.dedup_key ?? "");
    if (!match) continue;
    const messageId = Number(match[1]);
    if (Number.isSafeInteger(messageId) && messageId > 0) answered.add(messageId);
  }
  return answered;
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
  return Object.fromEntries(entries
    .filter((entry) => !entry.awaitingPlayerPick)
    .map((entry) => [
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
  const pickerObserved = new Set<number>();
  for (const message of messages) {
    if (message.sender_id !== geniusUserId) continue;
    const match = /^baseball-genius(?:-picker)?:(\d+)$/.exec(message.dedup_key ?? "");
    if (!match) continue;
    const messageId = Number(match[1]);
    if (Number.isSafeInteger(messageId) && messageId > 0) {
      if (isPickerReply(message)) {
        pickerObserved.add(messageId);
        const entries = readBaseballQaOutbox(storage).map((entry) =>
          entry.messageId === messageId
            ? { ...entry, acknowledged: true, awaitingPlayerPick: true }
            : entry,
        );
        writeBaseballQaOutbox(storage, entries);
      } else {
        observed.add(messageId);
      }
    }
  }
  if (observed.size === 0 && pickerObserved.size === 0) return [];

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
  return Array.from(new Set([...observed, ...pickerObserved]));
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
          ...(entry.pickedPlayerKboId
            ? { pickedPlayerKboId: entry.pickedPlayerKboId }
            : {}),
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
    current.map((entry) => {
      const update = updates.get(entry.messageId);
      if (!update) return entry;
      // 요청 중 picker 관측/선택이 발생하면 오래된 HTTP 응답이 그 새 상태를 덮지 못한다.
      if (entry.pickedPlayerKboId !== update.pickedPlayerKboId) return entry;
      if (entry.awaitingPlayerPick) {
        return { ...update, acknowledged: true, awaitingPlayerPick: true };
      }
      return update;
    }),
  );
  return result;
}
