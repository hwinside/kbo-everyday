/** 야잘알봇 시스템 계정. 배포 전 동일 UUID의 auth/profiles 계정을 프로비저닝한다. */
export const BASEBALL_GENIUS_USER_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
export const BASEBALL_GENIUS_NAME = "야잘알봇";

/** 하린아빠 확정 대기 중인 권장 기본값(spec §8). */
export const BASEBALL_GENIUS_DAILY_LIMIT = 20;
export const BASEBALL_GENIUS_PINNED_ROOM_LEAVABLE = false;
export const BASEBALL_GENIUS_MAX_ANSWER_LENGTH = 200;
export const BASEBALL_GENIUS_MIN_QUESTION_LENGTH = 2;
export const BASEBALL_GENIUS_MAX_QUESTION_LENGTH = 200;

/**
 * 야잘알봇 대화는 쪽지 푸시 알림에서 제외한다 (2026-08-02 하린아빠 지시).
 *
 * - 수신자가 야잘알봇: 시스템 계정이라 유저 질문 수신 푸시 자체가 무의미
 * - 발신자가 야잘알봇: 답변이 도착할 때마다 '✉️ 쪽지' 푸시가 함께 울려 소음이 된다.
 *   답변은 유저가 방금 질문하고 앱에서 확인하는 흐름이라 푸시가 필요 없다.
 *
 * 쪽지 저장·대화 목록·안읽음 표시는 그대로 두고 푸시만 막는다.
 */
export function isBaseballGeniusDmParticipant(
  senderId: string | null | undefined,
  receiverId: string | null | undefined,
): boolean {
  return senderId === BASEBALL_GENIUS_USER_ID || receiverId === BASEBALL_GENIUS_USER_ID;
}

/**
 * 답변 유형별 마스코트 상태 (2026-08-02 하린아빠 지시 — "design채널 캐릭터를
 * 답변 유형에 따라 매핑해서 답변 시 함께 노출"). design 채널 rev6 자산의 5상태와 1:1.
 */
export type GeniusMascotState = "idle" | "thinking" | "answering" | "praised" | "unknown";
export type GeniusReplyKind = "answer" | "ack" | "unavailable";

export const GENIUS_MASCOT_STATES: readonly GeniusMascotState[] = [
  "idle",
  "thinking",
  "answering",
  "praised",
  "unknown",
] as const;

/**
 * 답변 유형(MatchPath) → 마스코트 상태.
 *
 * 유형은 서버가 답변 저장 시점에 `dm_messages.payload` 에 기록한다(SSOT, A안).
 * 클라가 답변 텍스트를 상수와 대조하는 방식(B안)은 문구가 바뀌는 순간 조용히 깨진다.
 *
 * MatchPath 전체를 다 적지 않는다 — `pending` 은 다른 worker 가 이기고 이 worker 는
 * 물러나는 경우라 애초에 쪽지가 발송되지 않는다(= payload 도 안 생긴다).
 */
const ANSWER_MATCH_PATHS = new Set(["dictionary", "cache", "llm"]);

export function replyKindForMatchPath(matchPath: string): GeniusReplyKind {
  if (ANSWER_MATCH_PATHS.has(matchPath)) return "answer";
  if (matchPath === "ack") return "ack";
  return "unavailable";
}

/**
 * ⚠️ 모르는 값은 `idle` 로 폴백한다. 배포 전 생성된 과거 답변은 payload 가 없고,
 * 서버에 새 MatchPath 가 추가되면 클라가 모르는 값을 받게 된다.
 * 그때 빈 칸이나 오류 대신 기본 표정을 보여준다.
 */
export function mascotStateForReplyKind(replyKind: GeniusReplyKind | null | undefined): GeniusMascotState {
  if (replyKind === "answer") return "answering";
  if (replyKind === "ack") return "praised";
  if (replyKind === "unavailable") return "unknown";
  return "idle";
}

/**
 * 마스코트 상태별 자산 경로.
 * 5상태 합집합 bbox 로 크롭돼 있어 상태가 바뀔도 몸통 크기·위치가 고정된다
 * (상태별 타이트 크롭은 thinking/praised 가 팔을 뻗어 폭이 넓기 때문에 캐릭터가 튀다).
 */
export function geniusMascotSrc(state: GeniusMascotState): string {
  return `/mascot/reply/yajalal-${state}-96.png`;
}

/** 답변 유형을 실은 쪽지 payload. 서버가 쓰고 클라가 읽는다. */
export interface GeniusReplyPayload {
  type: "baseball_genius_reply";
  reply_kind: GeniusReplyKind;
  match_path: string;
}

/**
 * payload 가 야잘알봇 답변 유형인지 판정.
 *
 * ⚠️ 발신자 검증은 호출부 책임이다 — 유저가 payload 를 훌내내도 마스코트가 붙지 않게
 * 봇 발신(sender_id === BASEBALL_GENIUS_USER_ID)일 때만 이 함수를 통과시킨다.
 * (뉴스클리핑 카드가 PR #619 리뷰에서 똑같은 이유로 trustedSender 게이트를 달았다.)
 */
export function isGeniusReplyPayload(p: unknown): p is GeniusReplyPayload {
  if (!p || typeof p !== "object") return false;
  const obj = p as { type?: unknown; reply_kind?: unknown; match_path?: unknown };
  return obj.type === "baseball_genius_reply" &&
    (obj.reply_kind === "answer" || obj.reply_kind === "ack" || obj.reply_kind === "unavailable") &&
    typeof obj.match_path === "string";
}
