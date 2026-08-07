import type { MatchPath } from "@/lib/baseball-qa/pipeline";
import { resolveAllowedSource } from "@/lib/baseball-qa/genius-reply-provenance";

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
 * 답변 유형(MatchPath) → 의미 분류(reply_kind). **전 경로를 명시 열거한다.**
 *
 * 유형은 서버가 답변 저장 시점에 `dm_messages.payload` 에 기록한다(SSOT, A안).
 * 클라가 답변 텍스트를 상수와 대조하는 방식(B안)은 문구가 바뀌는 순간 조용히 깨진다.
 *
 * ⚠️ 열거형인 이유 (2026-08-04 운영 사고): 이전 구현은 `answer` 3종만 Set 으로 두고
 * 나머지를 전부 `unavailable` 로 폴백했다. 그 결과 새로 뚫린 선수 RAG 경로(`rag`)가
 * **정상 답변인데도 "모르겠어요" 취급**돼 마스코트가 `unknown` 표정으로 떴다.
 * 미분류를 조용한 폴백으로 흡수하면 새 경로가 추가될 때마다 같은 사고가 반복된다.
 * 그래서 여기서 전 경로를 명시하고, 회귀 게이트가 `MatchPath` union 과 이 키 집합을
 * 대조해 **미분류 경로를 RED 로 잡는다**.
 *
 * `pending` 은 다른 worker 가 이기고 이 worker 는 물러나는 경우라 애초에 쪽지가
 * 발송되지 않는다(= payload 도 안 생긴다). 유일한 열거 제외 대상이다.
 */
export const MATCH_PATH_REPLY_KIND = {
  // 답변을 실제로 내보낸 경로
  dictionary: "answer",
  cache: "answer",
  llm: "answer",
  rag: "answer",
  // 구단 서술형 RAG. 선수 RAG 와 같은 "근거로 답한 것"이라 화면 취급은 동일하다.
  // (경로를 나눈 이유는 감사 대상 분리이지 UI 분기가 아니다 — 2026-08-07)
  team_rag: "answer",
  // 시즌 기록을 운영 DB 원값으로 돌려준 경로 — 이것도 답변이다.
  kbo_structured: "answer",
  // 감사·확인 인사
  ack: "ack",
  // 동명이인이라 선택지를 되물은 경로. 답변도 실패도 아닌 별도 상태다.
  player_picker: "picker",
  // 답하지 못한 경로
  blocked: "unavailable",
  unsure: "unavailable",
  limited: "unavailable",
  error: "unavailable",
  context_missing: "unavailable",
  service_redirect: "unavailable",
  history_hold: "unavailable",
  // `satisfies` 가 계약을 **컴파일타임에** 강제한다:
  //  - 새 MatchPath 를 추가하고 여기 안 적으면 → 타입 에러(누락 불가)
  //  - union 에 없는 키를 적으면 → 타입 에러(죽은 키 불가)
  // 소스 정규식으로 TS 표현의 의미를 추론하던 종전 게이트는 대문자 식별자를 전부
  // 거절 상수로 간주해 실제 생성답까지 제외하는 false-green 이 있었다(삼순 반대가설).
  // 타입 시스템이 판정 주체가 되면 그 추론 자체가 필요 없다.
} satisfies Record<Exclude<MatchPath, "pending">, GeniusReplyKind>;

/**
 * ⚠️ 런타임 폴백은 `unavailable` 로 유지한다. 서버가 먼저 배포돼 클라가 모르는 값을
 * 받는 창에서 화면이 깨지지 않아야 하기 때문이다. 다만 그 폴백이 미분류를 덮어
 * 감추지 않도록, 열거 누락 자체는 위 게이트가 빌드에서 막는다.
 */
export function replyKindForMatchPath(matchPath: string): GeniusReplyKind {
  // 인덱싱을 위해서만 넓힌다. 테이블 자체는 `satisfies` 로 union 과 정확히 묶여 있으므로
  // 이 캐스트가 열거 누락을 감추지 않는다(누락은 위에서 컴파일 에러).
  const table: Readonly<Record<string, GeniusReplyKind>> = MATCH_PATH_REPLY_KIND;
  // ⚠️ **own-property 로만 조회한다** (삼순 6차 P1). 서버 payload 의 `match_path` 는
  // 외부에서 들어온 문자열이라 `constructor`·`__proto__`·`toString` 같은 프로토타입 키가
  // 올 수 있다. 그냥 인덱싱하면 `Object` 함수나 프로토타입 객체가 반환되고, 그 값은
  // `?? "unavailable"` 폴백을 그대로 통과해 `mascotStateForReplyKind()` 에서
  // 어느 분기에도 안 걸려 `idle` 로 떨어진다 — 모르는 값은 `unknown` 이어야 한다는
  // 문서·타입 계약과 어긋난다.
  // `Object.hasOwn` 대신 `hasOwnProperty.call` 을 쓴다 — 전자는 ES2022라 구형 Android
  // WebView(Capacitor 탑재)에서 없을 수 있고, 그 밍은 런타임에서만 터진다.
  if (!Object.prototype.hasOwnProperty.call(table, matchPath)) return "unavailable";
  return table[matchPath] ?? "unavailable";
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
  /**
   * 이 답변이 대답한 **원 질문 쪽지 id**. 두 곳에서 쓴다.
   *  ① picker: 답변 도착 순서와 무관하게 exact 질문을 재처리한다.
   *  ② 품질 피드백(👍/👎): 어떤 질문에 대한 평가인지 exact 결속한다.
   *
   * ②를 위해 **모든 답변**에 싣는다. 답변 쪽지에서 `dedup_key` 문자열을 파싱해 역산하는
   * 방법도 있지만 접두 규칙(`baseball-genius:` / `baseball-genius-picker:`)이 바뀌는 순간
   * 조용히 깨진다 — 서버가 쓰는 구조화 필드가 SSOT다.
   */
  question_message_id?: number;
  /**
   * 근거 문서 링크. 본문에는 `📄 출처: 나무위키` 표시명만 있고, 클라는 이 URL 로
   * 그 문구에 앵커를 씨운다 (하린아빠 2026-08-05: "링크도 전문을 노출시키지 말고
   * '출처: 나무위키'로만 표시하고 하이퍼링크를 다는 방식으로").
   * 내부 메타(revision·crawledAt·asOf)는 여기 실지 않는다 — 유저가 볼 이유가 없고
   * `crawled` 같은 단어는 수집 사실을 화면에 적는 것이라 위험하다.
   */
  source_url?: string;
}

/** picker 선택지 상한 — 서버·클라이 공유하는 계약. */
export const GENIUS_PICKER_MAX_OPTIONS = 6;

/**
 * picker 카드를 비활성화해야 하는가.
 *
 * 재탭하면 서버는 dedup 200만 돌려주고 새 DM 이 안 생겨 typing 이 영원히 돌았다.
 * 그래서 ①이미 최종 답변이 달린 과거 picker 와 ②이번에 이미 고른 picker 를 닫는다.
 *
 * ⚠️ `questionMessageId` 가 없으면 **fail-close**(disabled) 다 — 어느 질문을 가리키는지
 * 모르면 재처리 대상을 특정할 수 없어 클릭을 받아도 아무 일도 못 한다.
 *
 * 이 판정을 페이지 인라인으로 두면 회귀 게이트가 실제 렌더 계약을 잡지 못해
 * 공용 함수로 뽑았다(삼순 7차 P0-1).
 */
export function isGeniusPickerDisabled(
  questionMessageId: number | undefined,
  answeredQuestionIds: ReadonlySet<number>,
  pickedQuestionIds: ReadonlySet<number>,
): boolean {
  if (!questionMessageId) return true;
  return answeredQuestionIds.has(questionMessageId) || pickedQuestionIds.has(questionMessageId);
}

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
  const obj = p as { type?: unknown; reply_kind?: unknown; match_path?: unknown; picker_options?: unknown; question_message_id?: unknown; source_url?: unknown };
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
  if (obj.reply_kind === "picker" &&
      (!Number.isSafeInteger(obj.question_message_id) || Number(obj.question_message_id) < 1)) return false;
  // picker 가 아니어도 값이 실려 오면 형식을 검증한다 — 피드백이 이 값을 결속키로 쓰므로
  // 깨진 값이 통과하면 잘못된 질문에 평가가 붙는다.
  if (obj.reply_kind !== "picker" && obj.question_message_id !== undefined &&
      (!Number.isSafeInteger(obj.question_message_id) || Number(obj.question_message_id) < 1)) return false;
  // 입력이 외부에서 오므로 **allowlist hostname 을 실제 URL 파서로 대조**한다 (삼순 P0-2).
  // `https://` 접두 문자열 검사는 `https://namu.wiki@evil.com/` 같은 형태에 뚫리고,
  // 임의 외부 주소가 그대로 출처 링크가 되면서 `KBO 공식 자료` 라벨까지 달릴 수 있다.
  if (obj.source_url !== undefined &&
      (typeof obj.source_url !== "string" || resolveAllowedSource(obj.source_url) === null)) return false;
  return true;
}
