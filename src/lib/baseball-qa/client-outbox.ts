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
  /** 교정 카드에서 유저가 고른 서버 발급 exact 후보. */
  pickedNormalizedQuestion?: string;
  /** 교정 제안을 거절하고 원문 그대로 답변받겠다고 한 경우. */
  declineCorrection?: boolean;
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

export interface BaseballQaReplyMessage {
  sender_id: string | null;
  dedup_key?: string | null;
  payload?: unknown;
}

/**
 * "답변이 아니라 **선택을 기다리는** 카드" 의 dedup_key 접두 SSOT.
 *
 * 선수 picker 와 교정 카드는 종류가 같다 — 둘 다 outbox 를 보존해야 유저 클릭이 원 질문을
 * 재처리하고, 둘 다 선행 관측 · late-enqueue 복원에서 같은 취급을 받아야 한다.
 *
 * 🔴 직전 회차 결손(삼순 2026-08-13 교정 DM 선행 race): 이 목록이 여러 곳에 하드코딩돼
 *    있어 `useDM` 쪽만 picker 키만 보고 있었고, 교정 DM 이 질문 INSERT 응답보다 먼저
 *    도착하면 outbox 가 active 로 재생성돼 202 재시도/typing 이 반복됐다.
 *    이제 모든 소비자가 이 상수를 참조한다 — 새 카드 종류가 생기면 여기 한 줄만 늘어난다.
 */
export const BASEBALL_QA_SELECTION_DEDUP_KEYS = [
  "baseball-genius-picker:",
  "baseball-genius-correction:",
] as const;

function isPickerReply(message: BaseballQaReplyMessage): boolean {
  if (BASEBALL_QA_SELECTION_DEDUP_KEYS.some((prefix) => message.dedup_key?.startsWith(prefix))) {
    return true;
  }
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
          (typeof row.pickedPlayerKboId === "string" && row.pickedPlayerKboId.length > 0)) &&
        (row.pickedNormalizedQuestion === undefined ||
          (typeof row.pickedNormalizedQuestion === "string" && row.pickedNormalizedQuestion.length > 0 && row.pickedNormalizedQuestion.length <= 200)) &&
        (row.declineCorrection === undefined || typeof row.declineCorrection === "boolean") &&
        // 선택과 거절을 동시에 든 행은 서버가 400 으로 막는다 — 복원 단계에서 버린다.
        !(typeof row.pickedNormalizedQuestion === "string" && row.declineCorrection === true),
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
export function applyBaseballQaQuestionCorrection(
  storage: StorageLike, conversationId: string, messageId: number, pickedNormalizedQuestion: string,
  alreadyAnswered = false,
): boolean {
  if (alreadyAnswered || pickedNormalizedQuestion.length < 1 || pickedNormalizedQuestion.length > 200) return false;
  const entries = readBaseballQaOutbox(storage);
  const index = entries.findIndex((row) => row.messageId === messageId);
  const selected: BaseballQaOutboxEntry = {
    conversationId, messageId, pickedNormalizedQuestion, attempts: 0, acknowledged: false, awaitingPlayerPick: false,
    declineCorrection: false,
  };
  if (index >= 0) entries[index] = { ...entries[index], ...selected };
  else entries.push(selected);
  writeBaseballQaOutbox(storage, entries);
  return true;
}

/** 교정 제안 거절 — 원문 그대로 답변받는다. 같은 messageId 를 재처리하므로 quota 중복은 없다. */
export function declineBaseballQaQuestionCorrection(
  storage: StorageLike, conversationId: string, messageId: number, alreadyAnswered = false,
): boolean {
  if (alreadyAnswered) return false;
  const entries = readBaseballQaOutbox(storage);
  const index = entries.findIndex((row) => row.messageId === messageId);
  const declined: BaseballQaOutboxEntry = {
    conversationId, messageId, declineCorrection: true, attempts: 0, acknowledged: false, awaitingPlayerPick: false,
  };
  // 선택값이 이미 있으면 거절로 덮지 않는다 — 먼저 확정된 응답이 이긴다(서버와 같은 계약).
  if (index >= 0) {
    if (entries[index].pickedNormalizedQuestion) return false;
    entries[index] = { ...entries[index], ...declined };
  } else entries.push(declined);
  writeBaseballQaOutbox(storage, entries);
  return true;
}

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

/**
 * answered 집합을 **누적 merge** 한다 — 교체하지 않는다 (삼순 5차 P0-a).
 *
 * 관측은 두 경로로 들어온다: 전체 히스토리 재조회와 Realtime INSERT **단건**.
 * 단건 증분으로 집합을 교체하면 그 메시지 하나에 없는 answered id 가 전부 사라져
 * 이미 답변된 과거 picker 가 다시 활성화되고, 그걸 탭하면 영구 typing 이 재발한다.
 *
 * 참조 동일성을 유지해야 불필요한 리렌더가 안 생기므로, 새 id 가 없으면 `prev` 그대로 돌려준다.
 * 집합 초기화는 대화 전환 시점에서만 한다(이 함수는 줄이지 않는다).
 */
export function mergeBaseballQaAnsweredQuestionIds(
  prev: ReadonlySet<number>,
  messages: BaseballQaReplyMessage[],
  geniusUserId: string,
): ReadonlySet<number> {
  const observed = collectBaseballQaAnsweredQuestionIds(messages, geniusUserId);
  let hasNew = false;
  for (const id of observed) {
    if (!prev.has(id)) {
      hasNew = true;
      break;
    }
  }
  if (!hasNew) return prev;
  const merged = new Set(prev);
  for (const id of observed) merged.add(id);
  return merged;
}

/**
 * `setGeniusAnsweredQuestionIds` 에 그대로 넘길 **React updater** 를 만든다 (삼순 6차 P0-3).
 *
 * ⚠️ 왜 factory 인가: 종전에는 hook 이 `setState((prev) => merge(prev, msgs, id))` 를 직접 썼다.
 * 그러면 **call-site 가 `prev` 를 직접 손에 쥐고 있어** `merge(new Set(), msgs, id)` 로 바꾸는
 * 순간 누적이 사라진다(= 과거 answered 유실 → picker 재활성 → 영구 typing 재발).
 * helper 단위 테스트는 그 변종을 못 잡는다 — helper 는 멀지하기 때문이다.
 *
 * factory 는 `prev` 를 인자로 받지 않는다. 유일한 `prev` 공급자는 React 자신이므로
 * call-site 에는 손대서 망가뜨릴 자리 자체가 없다(구조적 불변).
 */
export function createBaseballQaAnsweredUpdater(
  messages: BaseballQaReplyMessage[],
  geniusUserId: string,
): (prev: ReadonlySet<number>) => ReadonlySet<number> {
  return (prev) => mergeBaseballQaAnsweredQuestionIds(prev, messages, geniusUserId);
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
    const match = /^baseball-genius(?:-(?:picker|correction))?:(\d+)$/.exec(message.dedup_key ?? "");
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
          ...(entry.pickedNormalizedQuestion
            ? { pickedNormalizedQuestion: entry.pickedNormalizedQuestion }
            : {}),
          ...(entry.declineCorrection ? { declineCorrection: true } : {}),
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
      if (entry.pickedPlayerKboId !== update.pickedPlayerKboId ||
          entry.pickedNormalizedQuestion !== update.pickedNormalizedQuestion ||
          entry.declineCorrection !== update.declineCorrection) return entry;
      if (entry.awaitingPlayerPick) {
        return { ...update, acknowledged: true, awaitingPlayerPick: true };
      }
      return update;
    }),
  );
  return result;
}
