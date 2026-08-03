/** 야잘알봇 시스템 계정. 배포 전 동일 UUID의 auth/profiles 계정을 프로비저닝한다. */
export const BASEBALL_GENIUS_USER_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
export const BASEBALL_GENIUS_NAME = "야잘알봇";

/** 하린아빠 확정 대기 중인 권장 기본값(spec §8). */
export const BASEBALL_GENIUS_DAILY_LIMIT = 20;
export const BASEBALL_GENIUS_PINNED_ROOM_LEAVABLE = false;
export const BASEBALL_GENIUS_MAX_ANSWER_LENGTH = 200;
export const BASEBALL_GENIUS_MIN_QUESTION_LENGTH = 2;
export const BASEBALL_GENIUS_MAX_QUESTION_LENGTH = 200;
export const BASEBALL_GENIUS_FALLBACK_ANSWER =
  "야구 룰/용어에 대한 질문만 답할 수 있어요. 예: \"보크가 뭐야?\"";

/**
 * 답변 유형별 마스코트 상태 (2026-08-02 하린아빠 지시 — "design채널 캐릭터를
 * 답변 유형에 따라 매핑해서 답변 시 함께 노출"). design 채널 rev6 자산의 5상태와 1:1.
 */
export type GeniusMascotState = "idle" | "thinking" | "answering" | "praised" | "unknown";
// `picker` = 동명이인이라 되물는 중. 답변도 실패도 아니라 별도 종류다.
export type GeniusReplyKind = "answer" | "ack" | "unavailable" | "picker";

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
// `kbo_structured` 도 답변이다 — 시즌 기록을 운영 DB 원값으로 돌려준 경우.
const ANSWER_MATCH_PATHS = new Set(["dictionary", "cache", "llm", "rag", "kbo_structured"]);

export function replyKindForMatchPath(matchPath: string): GeniusReplyKind {
  if (ANSWER_MATCH_PATHS.has(matchPath)) return "answer";
  if (matchPath === "ack") return "ack";
  if (matchPath === "player_picker") return "picker";
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
  // 되물는 중은 "모른다"가 아니라 "생각 중"이다 — unknown 표정을 쓰면 실패처럼 보인다.
  if (replyKind === "picker") return "thinking";
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

/**
 * 동명이인 picker 선택지 1개.
 *
 * 로스터 실측(2026-08-03): 880명 중 32그룹 72명이 동명이인이며 그중 7그룹은 **같은 팀에도**
 * 동명이인이 있다. 그래서 팀만 보여주면 구분이 안 되고 등번호·포지션까지 필요하다
 * (이름+팀+등번호 조합은 로스터에서 유일함을 확인했다).
 */
export interface GeniusPickerOption {
  kbo_id: string;
  name: string;
  team: string | null;
  position: string | null;
  back_no: string | null;
}

/** 답변 유형을 실은 쪽지 payload. 서버가 쓰고 클라가 읽는다. */
export interface GeniusReplyPayload {
  type: "baseball_genius_reply";
  reply_kind: GeniusReplyKind;
  match_path: string;
  /** `reply_kind === "picker"` 일 때만. 클라가 선택 카드를 렌더한다. */
  picker_options?: GeniusPickerOption[];
}

/** picker 선택지 상한 — 서버·클라이 공유하는 계약. */
export const GENIUS_PICKER_MAX_OPTIONS = 6;

function isPickerOption(p: unknown): p is GeniusPickerOption {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.kbo_id === "string" && o.kbo_id.length > 0 &&
    typeof o.name === "string" && o.name.length > 0 &&
    (o.team === null || typeof o.team === "string") &&
    (o.position === null || typeof o.position === "string") &&
    (o.back_no === null || typeof o.back_no === "string");
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
  const obj = p as { type?: unknown; reply_kind?: unknown; match_path?: unknown; picker_options?: unknown };
  if (obj.type !== "baseball_genius_reply" || typeof obj.match_path !== "string") return false;
  if (
    obj.reply_kind !== "answer" && obj.reply_kind !== "ack" &&
    obj.reply_kind !== "unavailable" && obj.reply_kind !== "picker"
  ) return false;
  // 선택지가 붙어 있으면 항목까지 검증한다 — 깨진 payload 로 카드를 그리면 빈 버튼이 난다.
  // 상한 초과도 거절한다(무한 목록 렌더 방지).
  if (obj.picker_options !== undefined) {
    if (!Array.isArray(obj.picker_options)) return false;
    if (obj.picker_options.length === 0 || obj.picker_options.length > GENIUS_PICKER_MAX_OPTIONS) return false;
    if (!obj.picker_options.every(isPickerOption)) return false;
  }
  // picker 라고 주장하면서 선택지가 없으면 렌더할 것이 없다 — 유효한 payload 가 아니다.
  if (obj.reply_kind === "picker" && obj.picker_options === undefined) return false;
  return true;
}
