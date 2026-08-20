import type { MatchPath } from "@/lib/baseball-qa/pipeline";
import { resolveAllowedSource } from "@/lib/baseball-qa/genius-reply-provenance";
import { BASEBALL_GENIUS_ANSWER_MAX_CHARS } from "@/lib/baseball-qa/answer-budget";
import { TEAMS } from "@/lib/constants/teams";

/** 야잘알봇 시스템 계정. 배포 전 동일 UUID의 auth/profiles 계정을 프로비저닝한다. */
export const BASEBALL_GENIUS_USER_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
export const BASEBALL_GENIUS_NAME = "야잘알봇";

/** 하린아빠 확정 대기 중인 권장 기본값(spec §8). */
export const BASEBALL_GENIUS_DAILY_LIMIT = 20;
export const BASEBALL_GENIUS_PINNED_ROOM_LEAVABLE = false;
// tier1/tier2 RAG 상한과 **같은 예산 SSOT 를 파생**한다 (2026-08-10 성의 계약 — 유형별
// 목표 길이는 프롬프트가, 안전 상한은 이 값이 고정한다. 삼순: "generic 200자 계약
// 그대로면 adaptive-length 미완"). 200 → 320(08-10) → 700(08-16 "너무 짧게 즉답형").
// ⚠️ 리터럴 재기술 금지 — 세 상한이 갈라지면 같은 질문이 경로에 따라 다른 길이로 잘린다.
export const BASEBALL_GENIUS_MAX_ANSWER_LENGTH = BASEBALL_GENIUS_ANSWER_MAX_CHARS;
export const BASEBALL_GENIUS_MIN_QUESTION_LENGTH = 2;
export const BASEBALL_GENIUS_MAX_QUESTION_LENGTH = 200;
/**
 * ① **범위 밖** 안내 — "이건 야구 질문이 아니다"라고 **확신할 때만** 쓴다.
 *
 * ⚠️ 2026-08-05 하린아빠 지시: "명확히 야구 관련된 질문이 아니다라는 확신이 있을 때만
 * 첫번째 답변으로." 그 전까지는 이 문구 하나를 **모든 실패 경로가 공유**해서,
 * `내야수는 모야`처럼 명백한 야구 용어 질문에도 "룰/용어만 답할 수 있어요"가 나갔다.
 * 운영 로그 실측(2026-08-05): 미답변 1,075건 중 대다수가 기초 야구 용어였다
 * (`적시타가 뭐야` 11회 · `홈런이 모야?` · `삼자범퇴` · `유격수` · `타수` …).
 *
 * ⚠️ 2026-08-08 문구 현행화. 종전 문구("야구 룰/용어에 대한 질문만")는 **출시 초기
 * 범위에 멈춰 있던 거짓말**이었다. 그 사이 구단 RAG(#1110)·선수 RAG·시즌 기록
 * (`kbo_structured`)·최신 기사 RAG(#1127)가 전부 배포돼 봇은 이미 그것들을 답한다.
 * 운영 로그 실측(최근 3일 미답변 196건): `야구 룰`·`야구 규칙`처럼 **우리가 안내한
 * 그 범위를 그대로 되물은** 질문이 16건이었다. 안내가 실제 능력보다 좁으면
 * 유저는 답할 수 있는 질문을 아예 하지 않는다.
 *
 * 범위를 넓힐 때는 반드시 **그 경로가 실제로 배포된 뒤**에만 문구에 넣는다
 * ("답할 수 있어요"라고 해놓고 못 답하면 종전과 반대 방향의 같은 거짓말이다).
 *
 * ⚠️ 그래서 기록은 **`일부 기록`** 으로 쓴다(삼순 2026-08-08 조건 ① — 과장 방지).
 * 우리가 답하는 건 **2026 시즌의 allowlist 지표**뿐이다. 실측으로 못 답하는 것:
 *   · 과거 시즌·통산 전부(`UNSUPPORTED_SEASON_WORDS` — DB 에 row 가 없다)
 *   · 타석·희생번트·희생플라이 등(`UNTRUSTED_METRIC_ALIASES` — 값은 있으나 믿을 수 없다)
 *   · 팀 단위 집계 수치(`TEAM_STAT_HOLD_ANSWER` 이 따로 담당)
 * `기록` 이라고만 쓰면 통산·작년까지 답하는 것처럼 읽힌다 — 좀 전에 고친 거짓말을
 * 반대 방향으로 다시 만드는 셈이다.
 */
export const BASEBALL_GENIUS_FALLBACK_ANSWER =
  "제가 확인할 수 있는 범위는 야구 룰·용어, 구단, 선수, 일부 기록, 최근 소식입니다. 예: \"보크가 뭐야?\"";

/**
 * **답변 가능 경로 → 유저에게 밝혀야 하는 범위어** (SSOT).
 *
 * 왜 필요한가 — 거절 문구가 **실제 능력보다 좁게 썰기는 사고가 반복됐다.** 구단·선수·기록·
 * 기사 경로를 차례로 열어놓고도 문구는 "룰/용어만"에 멈춰 있었다. 사람이 두 곳을 같이
 * 고치는 규율에 기대면 또 어긋난다.
 *
 * 그래서 **타입으로 묶는다**: `MATCH_PATH_REPLY_KIND` 에서 `answer` 로 선언된 경로는
 * 전부 여기 범위어가 있어야 하고(`satisfies` 가 누락을 컴파일에서 막는다), 거절 문구는
 * 그 범위어를 전부 담아야 한다(게이트가 대조). 즉 새 답변 경로를 붙이면 문구 갱신을
 * **안 하고는 빌드가 안 된다.**
 *
 * ⚠️ `리터럴 문자열 포함` 검사라 문구를 예뻐게 다듬는 건 자유지만, 이 단어들은 남아야 한다.
 * 단어를 바꾸고 싶으면 이 표와 문구를 같이 바꾸면 된다 — 둘을 같이 바꾸는 것이 바로 계약이다.
 *
 * `dictionary`·`cache`·`llm` 은 생성 경로가 아니라 **주제**가 같아 한 칸(룰·용어)을 공유한다.
 */
/**
 * `MATCH_PATH_REPLY_KIND` 에서 **실제 답변을 내보낸** 경로만 뽑은 파생 타입.
 *
 * 손으로 다시 열거하지 않는다 — 열거하면 `MATCH_PATH_REPLY_KIND` 와 갈라질 수 있고,
 * 그 갈라짐은 조용하다(타입은 통과하고 문구만 틀린다). `satisfies` 가 유지하는 리터럴
 * 타입 덕에 `answer` 선언만으로 집합이 확정된다.
 */
export type AnswerableMatchPath = {
  [K in keyof typeof MATCH_PATH_REPLY_KIND]: (typeof MATCH_PATH_REPLY_KIND)[K] extends "answer"
    ? K
    : never;
}[keyof typeof MATCH_PATH_REPLY_KIND];

export const ANSWER_PATH_SCOPE_WORD = {
  dictionary: "용어",
  cache: "용어",
  llm: "룰",
  // 선수 서술형 tier2 RAG
  rag: "선수",
  // 구단 문서 RAG (#1110)
  team_rag: "구단",
  // 최근 30일 기사 RAG (#1127)
  news_rag: "최근 소식",
  //
  // ⚠️ **`일부 기록`** 이지 `기록` 이 아니다(삼순 2026-08-08 조건 ① — 과장 방지).
  //   이 경로가 답하는 건 **2026 시즌의 allowlist 지표**만이고, 과거 시즌·통산·
  //   믿을 수 없는 지표(타석·희생타 등)·팀 단위 집계는 전부 fail-close 한다.
  //   범위어를 넓게 적으면 거절 문구가 **반대 방향의 거짓말**이 된다.
  kbo_structured: "일부 기록",
} satisfies Record<AnswerableMatchPath, string>;

/**
 * ② **이해 못함** 안내 — 우리가 질문을 해석하지 못했을 때.
 *
 * ①과 갈라야 하는 이유: 둘은 유저에게 완전히 다른 사실을 말한다.
 *  - ① = "그건 우리가 다루는 주제가 아니다" (유저가 다시 물어도 소용없음)
 *  - ② = "주제는 맞는데 우리가 못 알아들었다" (다시 물으면 될 수 있음)
 * ①을 남발하면 야구 질문을 한 유저에게 "야구 질문만 하라"고 답하는 꼴이 된다.
 */
export const BASEBALL_GENIUS_UNCLEAR_ANSWER =
  "질문을 정확히 이해하지 못했습니다. 내용을 조금 더 구체적으로 적어 주시면 다시 확인하겠습니다.";

/**
 * ②' **자료 부족** 안내 — 질문은 이해했지만 근거 자료가 부족해 답을 못 만든 경우
 * (2026-08-19 맛자욱 P0 — `model_insufficient` 문구 분리).
 *
 * ②(UNCLEAR)와 갈라야 하는 이유: RAG 검색은 됝으나 모델이 근거 부족으로 판정한 건을
 * "질문을 이해 못했다"로 보내면 유저는 문장을 고쳐 재질문한다 — 고쳐도 자료가 없으니
 * 결과는 같고, 우리 결손(자료 커버리지)을 유저 탓으로 돌린다. 유저가 할 수 있는
 * 행동(다른 질문 · 나중에 다시)만 적는다 — 내부 사정(RAG·모델)은 적지 않는다.
 */
export const BASEBALL_GENIUS_INSUFFICIENT_ANSWER =
  "질문은 이해했지만 지금 가진 자료로는 정확한 답을 드리기 어렵습니다. 자료를 보강해 답변할 수 있도록 준비하겠습니다.";

/**
 * ③ **시스템 오류** 안내 — 우리 쪽이 고장났을 때.
 *
 * ②와도 갈라야 하는 이유 (삼순 2026-08-08 ①): 둘을 한 문구로 합치면 **우리 장애를
 * 유저 탓으로 돌린다.** RPC 가 죽어서 못 답한 건데 "질문을 정확히 이해하지 못했어요" 를
 * 보내면, 유저는 자기 질문이 이상했다고 믿고 문장을 고쳐 다시 쓴다 — 고칠 게 없는데.
 *
 * 세 문구가 유저에게 말하는 사실:
 *   ① BLOCKED  = "그건 우리가 다루는 주제가 아니다"   → 다시 물어도 소용없다
 *   ② UNCLEAR  = "주제는 맞는데 못 알아들었다"        → 다시 쓰면 될 수 있다
 *   ③ ERROR    = "우리가 고장났다"                    → 그대로 다시 보내면 된다
 *
 * ⚠️ 내부 사정(RPC·LLM·타임아웃)은 문구에 적지 않는다 — 유저가 할 수 있는 행동만 적는다.
 */
export const BASEBALL_GENIUS_SYSTEM_ERROR_ANSWER =
  "일시적인 문제로 답변을 만들지 못했습니다. 같은 질문을 다시 보내 주시면 다시 확인하겠습니다.";

/**
 * ④ **이름 교정 제안** — 로스터에 없는 실명인데 한 글자만 다른 선수가 있을 때.
 *
 * 왜 생겼나 (2026-08-08 하린아빠 제보, Production 실측):
 *   유저 `임창규 어떤 선수야`  →  봇 "임창규는 LG 트윈스의 주축 선수로…"
 * 로스터 881명에 `임창규` 는 **없다**(`임찬규` kboId 61101 만 있다). 결속된 근거가
 * 하나도 없는 상태로 generic LLM 이 받아서 **존재하지 않는 사람을 실존으로 만들고**
 * 소속과 위상까지 붙였다. 수치 환각보다 나쁜 종류다 — 유저는 틀렸다는 걸 알 방법이 없다.
 *
 * 문구가 거절이 아니라 **제안**인 이유: 유저는 야구 질문을 제대로 했고 오타만 났다.
 * "야구 이야기만 답해요"(BLOCKED)는 질문을 탓하는 말이고, "모르겠어요"(UNCLEAR)는
 * 우리가 아는 걸 숨기는 말이다. 정확한 다음 행동은 맞는 이름을 알려주는 것이다.
 *
 * ⚠️ 단수형이다 — 후보가 **정확히 1명**일 때만 쓴다. 여러 명이면 고르라고 묻는 게 맞지만
 *   그건 picker 의 일이라 이 문구의 책임이 아니다.
 */
export const BASEBALL_GENIUS_NAME_SUGGEST_ANSWER = (suggested: string): string =>
  `혹시 ${suggested} 선수를 말씀하신 겁니까? 그 이름으로 다시 물어봐 주시면 확인하겠습니다.`;

/**
 * ⑤ **미결속 실명 · 제안할 이름 없음** — 로스터에 없고 가까운 후보도 없을 때.
 *
 * 왜 별도 문구가 필요한가 (삼순 2026-08-08 P0):
 * 초안은 "한 글자만 다른 선수가 정확히 1명"일 때만 막았다. 그러면 `오타니 잘해?`·
 * `홍길동 어떤 선수야` 처럼 **이웃이 없는 이름은 그대로 generic LLM 으로 샌다** —
 * 정작 제일 위험한 축(로스터 밖 실존 인물·완전 허구)이 열려 있었다.
 *
 * 그래서 판정을 뒤집었다: **막는 게 기본이고, 제안은 후보가 유일할 때만 얹는 편의**다.
 * 이 문구는 그 기본값이다 — 모른다고 말할 뿐 **어떤 사실도 만들지 않는다.**
 *
 * ⚠️ `UNCLEAR`(못 알아들었다)와 다르다. 우리는 질문을 알아들었고, 그 이름을 우리
 *   로스터에서 못 찾았을 뿐이다. 유저가 취할 다음 행동이 다르므로 문구도 다르다.
 */
export const BASEBALL_GENIUS_NAME_UNKNOWN_ANSWER =
  "KBO 현역 선수 명단에서 그 이름을 찾지 못했습니다. 이름을 다시 확인해서 물어봐 주시면 확인하겠습니다.";

/**
 * 답변 유형별 마스코트 상태 (2026-08-02 하린아빠 지시 — "design채널 캐릭터를
 * 답변 유형에 따라 매핑해서 답변 시 함께 노출"). design 채널 rev6 자산의 5상태와 1:1.
 */
export type GeniusMascotState = "idle" | "thinking" | "answering" | "praised" | "unknown";
// `picker` = 동명이인이라 되물는 중. 답변도 실패도 아니라 별도 종류다.
export type GeniusReplyKind = "answer" | "ack" | "unavailable" | "picker" | "correction";

export const GENIUS_MASCOT_STATES: readonly GeniusMascotState[] = [
  "idle",
  "thinking",
  "answering",
  "praised",
  "unknown",
] as const;

/**
 * 마스코트 **모션** — 답변 유형별 애니메이션 (SSOT §7.6, 2026-08-15 하린아빠 착수 지시).
 *
 *   인사 → excited(신남) / 감사·칭찬 → headspin(헤드스핀) / 거절 → bored(심심함)
 *
 * 상태(GeniusMascotState = 어느 그림)와는 별개 축이다 — 모션은 그 그림에 CSS
 * 애니메이션을 입힐지만 정한다(애니메이션 이미지 자산 없음 — 2026-08-15 실측,
 * public/mascot/reply 는 정적 PNG 5상태뿐이다).
 *
 * ⚠️ **채팅창에는 항상 최신 1개만 움직인다** (하린아빠 2026-08-15 13:34: "이전에
 * 보여줬던 모션은 새로운 모션이 등장하면 사라져야 함. 그래야 일관되게 하나의 봇과
 * 대화하는 느낌"). 그 판정은 클라(page)가 메시지 목록에서 순수 파생한다 —
 * 상태·localStorage 없이 데이터만으로 결정되며 reload 에서도 같은 결과다.
 */
export type GeniusMascotMotion = "excited" | "headspin" | "bored";

export const GENIUS_MASCOT_MOTIONS: readonly GeniusMascotMotion[] = [
  "excited",
  "headspin",
  "bored",
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
  // 최근 30일 구단 기사 근거로 답한 경로. 화면 취급은 다른 RAG 와 동일하다
  // (경로를 나눈 이유는 근거 수명이 30일로 유한해 감사 축을 분리해야 하기 때문이지 UI 분기가 아니다).
  news_rag: "answer",
  // 시즌 기록을 운영 DB 원값으로 돌려준 경로 — 이것도 답변이다.
  kbo_structured: "answer",
  // 감사·확인 인사
  ack: "ack",
  // 범위 되묻기(`야구 룰`)에 범위 안내로 답한 경로.
  //
  // ⚠️ 화면 취급은 `ack` 과 **같다**(둘 다 질문이 아닌 대화 행위에 결정론으로 답한 것).
  //   경로를 나눈 이유는 UI 분기가 아니라 **감사 축 분리**다 — 범위 안내가 얼마나
  //   나갔는지, 그중 과차단은 몇 건인지 세려면 감사 인사와 한 칸에 있으면 안 된다.
  //   (`team_rag`·`news_rag` 를 `rag` 에서 분리한 것과 같은 이유.)
  scope_guide: "ack",
  // 동명이인이라 선택지를 되물은 경로. 답변도 실패도 아닌 별도 상태다.
  player_picker: "picker",
  // 문자 교정 후보를 자동 적용하지 않고 유저 확인을 기다리는 카드.
  question_correction: "correction",
  // 로스터에 없는 실명을 받아 이름을 되물은 경로.
  //
  // 화면 취급은 `player_picker` 와 같은 **되묻기**다 — 둘 다 "답을 못 했다"가 아니라
  // "누구를 말하는지 확인하면 답할 수 있다" 이다. 다만 picker 는 선택지 UI 를 띄우고
  // 이쪽은 문구만 보낸다 — 후보가 1명이라 고를 게 없기 때문이다.
  // 그래서 `reply_kind` 는 `ack`(결정론 단문 응답)과 같은 칸을 쓴다.
  // 실측된 이름 오타를 받아 **생성 없이** 그 이름을 되물은 경로.
  name_suggest: "ack",
  // 답하지 못한 경로
  blocked: "unavailable",
  unsure: "unavailable",
  // `<X> <지표>` 에서 X 를 운영 데이터로 특정하지 못해 되물은 경로.
  //
  // ⚠️ 화면 취급은 `unsure` 와 **같다**(둘 다 답을 못 준 상태). 경로를 나눈 이유는
  //   UI 분기가 아니라 **감사 축 분리**다 — `unsure` 는 LLM 까지 갔는데 확신 못 한 것이고
  //   이것은 애초에 대상을 특정 못 한 것이라 원인도 처방도 다르다.
  //   (`team_rag`·`news_rag`·`scope_guide` 를 나눈 것과 같은 이유.)
  stat_clarify: "unavailable",
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
  if (replyKind === "picker" || replyKind === "correction") return "thinking";
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
 * 대화 마스코트 렌더 규격 **SSOT** (2026-08-16 하린아빠 지시 — "캐릭터가 너무 작아서
 * 잘 안보임. 상단의 캐릭터 크기만큼 키워주고").
 *
 * 종전 `h-8`(32px)은 헤더 마스코트(`h-24` = 96px)의 1/3 이라 실기기에서 캐릭터가
 * 식별되지 않았다. 자산은 96px 원본(`yajalal-<state>-96.png`, 실측 77x96)이라
 * 96px 렌더는 **원본 크기 그대로**다 — 확대 보간이 아니다.
 *
 * ⚠️ 클래스 문자열을 사용처마다 복제하지 않는다. 복제하면 한쪽만 고쳐져도 게이트가
 * 못 잡는다(M90 `게이트가 상수를 재구현하면 결함을 못 본다` 계약과 같은 축).
 * 게이트는 이 상수를 **직접 import 해서** 검사한다.
 */
export const GENIUS_MASCOT_HEIGHT_PX = 96;
export const GENIUS_MASCOT_IMG_CLASS = "h-24 w-auto max-w-none object-contain";

/**
 * 상시 idle 미세 모션 클래스 (2026-08-16 하린아빠 지시 — "캐릭터가 안움직이는 것 같은데
 * 움직이게 해줘").
 *
 * §7.6 감정 모션(excited/headspin/bored)은 **감정 반응 전용**이라 지식 답변에는 아예
 * 붙지 않는다(`geniusMotionForResult` → undefined). 그래서 캡처처럼 일반 질문에
 * 답할 때는 캐릭터가 완전히 정지해 보인다.
 *
 * idle 은 감정 모션과 **별개 축**이다:
 *  · 부착 대상 = 화면에 실제로 렌더되는 그 마스코트 1개(소유권 판정은 page 가 그대로 소유).
 *  · 감정 모션과 **겹쳐 돈다** — idle 은 wrapper 에, 감정 모션은 img 에 걸어 transform
 *    충돌을 구조적으로 없앤다(같은 엘리먼트에 두 animation 을 걸면 뒤 선언이 transform 을
 *    통째로 덮어써 한쪽이 조용히 죽는다).
 *  · §7.4 "모션 30초 1회"는 **감정 반응 남용** 방지 계약이므로 idle 은 그 대상이 아니다.
 *    idle 은 DB claim 을 타지 않고 payload 에도 실리지 않는다(순수 표시 계층).
 */
export const GENIUS_MASCOT_IDLE_MOTION_CLASS = "genius-motion-idle inline-flex";

/* ══ 영상 모션 클립 13종 (2026-08-16 하린아빠 13:48 — "지금 연결된건 움직이는 것
   같지도 않아. 모두 폐기하고 활발하게 움직이는 버전들로 교체") ═════════════════

   종전 구조(정적 PNG 5상태 + CSS transform)는 **폐기**한다. CSS 미세 모션은
   사용자 눈에 "움직이지 않는" 수준이었다(하린아빠 실기기 판정).

   자산 출처 = `assets/mascot/v1`(8/7 고정 SSOT, MANIFEST.sha256). 그 black 합성본을
   원본으로 **투명배경 WebP 애니메이션**으로 재가공해 `public/mascot/motion/` 에 둔다.
   (종전 black/white 2벌은 테마 분기가 필요했고, 다크모드 고정인 크보팬에서도
   말풍선 배경과 정확히 같지 않아 네모가 보였다 — 투명이 유일한 정답이다.)

   ⚠️ **새 판별 룰을 추가하지 않는다**(삼순 확정). 경기일·마이팀 같은 새 입력을 들이지
   않고, 이미 있는 `reply_kind` + `messageId` 만으로 13종 전부가 도달 가능하다.
   즉 어휘를 늘리는 방향(M90 `open_language_never_closes_with_rules`)이 아니라
   **이미 닫힌 집합 안에서 결정론으로 고르는** 구조다. */
export type GeniusMotionClip =
  | "swing" | "pitching" | "thinking" | "headspin" | "excited" | "bored"
  | "cheer" | "cheerC" | "cheerD" | "cheerG"
  | "cheertowel" | "cheerstick" | "cheerpom";

export const GENIUS_MOTION_CLIPS: readonly GeniusMotionClip[] = [
  "swing", "pitching", "thinking", "headspin", "excited", "bored",
  "cheer", "cheerC", "cheerD", "cheerG",
  "cheertowel", "cheerstick", "cheerpom",
] as const;

/** 재생되는 애니메이션 WebP. 무한 루프는 자산 자체에 인코딩돼 있다(loop=0). */
export function geniusMotionSrc(clip: GeniusMotionClip): string {
  return `/mascot/motion/${clip}.webp`;
}

/**
 * 정지 poster (각 클립의 **첫 프레임**).
 *
 * ⚠️ 애니메이션 WebP 는 CSS `animation: none` 으로 멈춰지지 않는다 — 재생은
 * 이미지 디코더가 하며 CSS 관여 자체가 없다. 그래서 `prefers-reduced-motion` 에서는
 * **자산을 교체**해야 한다(삼순 지적). 미디어 쿼리로 poster 를 고르면 정지화된다.
 */
export function geniusMotionPosterSrc(clip: GeniusMotionClip): string {
  return `/mascot/motion/${clip}-poster.webp`;
}

/**
 * 정상 답변에 교대로 붙는 야구 동작 2종.
 * 답변이 연속될 때 같은 동작만 반복되면 정적 이미지처럼 보인다.
 */
const ANSWER_CLIPS = ["swing", "pitching"] as const;

/**
 * 답변 대상 선수 역할 폐쇄집합 (서버 payload ↔ 클라 공유 계약).
 * 역할이 확정된 답변은 교대 대신 역할에 맞는 동작을 재생한다
 * (하린아빠 2026-08-19 "박동원은 타자인데 투구모션" / 8-18 "투수인데 스윙").
 */
export const GENIUS_ANSWER_PLAYER_ROLES = ["pitcher", "batter"] as const;
export type GeniusAnswerPlayerRole = (typeof GENIUS_ANSWER_PLAYER_ROLES)[number];

/** 역할 → 클립 단일 매핑 — 투수는 던지고 타자는 친다. 의미가 있는 축이므로 시드 교대 금지. */
const ROLE_CLIPS: Readonly<Record<GeniusAnswerPlayerRole, GeniusMotionClip>> = {
  pitcher: "pitching",
  batter: "swing",
};

/**
 * 중립 클립 — 감정 반응이 **억제됐을 때** 쓰는 자리.
 *
 * 30초 쿨다운(#1202)이 감정 모션을 거절하면 감정 클립을 재생하지 않는다. 그렇다고
 * 아무 감정이나 붙이면(예: 감사에 신남) 쿨다운이 오히려 **틀린 신호**를 만든다.
 * 중립 야구 동작 하나로 고정해 "억제됨"을 결정론적으로 표현한다.
 */
const NEUTRAL_ACK_CLIP = "swing" as const;

/**
 * 응원 7종 — **유저 최애팀에 관한 답변에만** 붙는다.
 *
 * 하린아빠 2026-08-16 14:09 "응원세트는 최애팀 관련 답변 이후에 랜덤으로 노출".
 * 즉 응원은 아무 때나 뜨는 장식이 아니라 **"네 팀 얘기다"라는 신호**다.
 */
const CHEER_CLIPS = [
  "cheer", "cheerC", "cheerD", "cheerG",
  "cheertowel", "cheerstick", "cheerpom",
] as const;

/**
 * 응원 7종을 붙일 자격 판정 (**fail-close**).
 *
 * 응원은 "이 답변이 당신 팀 얘기다"라는 신호이므로, 그 전제가 **증명될 때만** 붙인다.
 * 최애팀 미설정·팀 판정 불가·다른 팀이면 전부 자격 없음이다 — 애매하면 안 붙인다
 * (삼순 #1228 P0: "모두 유효하고 같을 때만").
 *
 * ⚠️ 두 값 다 **canonical team id(number)** 여야 한다. 팀명 문자열로 비교하면
 *   `LG`/`엘지`/`트윈스` 표기 차이로 같은 팀이 다른 팀이 된다. 서버가 질문에서
 *   canonical 을 해석해 payload 에 id 로 실어야 하는 이유다.
 */
export function isFavoriteTeamAnswer(
  answerTeamId: number | null | undefined,
  favoriteTeamId: number | null | undefined,
): boolean {
  // ⚠️ **실존 구단 id 인지부터 본다** (삼순 #1228 4축-③).
  //    종전엔 `Number.isFinite` + 동등 비교만 해서, 두 값이 **똑같이 잘못된** 경우
  //    (0 vs 0 · -1 vs -1 · 1.5 vs 1.5 · 999 vs 999)를 전부 통과시켰다. 동등성만
  //    보면 "같으니 최애팀" 이 되어 존재하지도 않는 팀에 응원이 붙는다.
  //    실측: isFav(0,0)=true, isFav(999,999)=true 였다.
  return isRealTeamId(answerTeamId) && isRealTeamId(favoriteTeamId) &&
    answerTeamId === favoriteTeamId;
}

/**
 * KBO 10개 구단의 실제 team id 인가.
 *
 * `TEAMS`(구단 SSOT)에서 파생한다 — 여기에 1..10 을 리터럴로 적으면 구단이 늘거나
 * 재편될 때 조용히 어긋난다(M90 `게이트가 상수를 재구현하면 결함을 못 본다`와 같은 축).
 */
const REAL_TEAM_IDS: ReadonlySet<number> = new Set(TEAMS.map((team) => team.id));

export function isRealTeamId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && REAL_TEAM_IDS.has(value);
}

/**
 * `reply_kind` + `messageId` → 재생할 클립 (**결정론**).
 *
 * ⚠️ 무작위가 아니라 messageId 기반이다 — 같은 메시지는 reload·재진입·다른 기기에서도
 * 항상 같은 동작을 보여준다. `Math.random()` 이면 새로고침마다 동작이 바뀌어
 * "이 답변은 이 동작"이라는 인과가 깨진다(M90 결정론 계약과 같은 축).
 *
 * 매핑(삼순 2026-08-16 확정 + 4축-② 의미 매핑 복원):
 *  · **인사 → excited / 감사·칭찬 → headspin** — §7.6 의미 구분을 그대로 쓴다.
 *    ⚠️ 이 둘을 messageId 로 교대시키면 "고마워"에 신남이, "안녕"에 헤드스핀이
 *       나온다. 시드 교대는 **의미가 없는 축에서만** 쓴다(삼순 #1228 4축-②).
 *  · answer + **선수 역할 확정**  → 투수=pitching / 타자·야수=swing (하린아빠 2026-08-19)
 *  · answer(역할 미상)         → swing / pitching 교대 (의미 구분 없는 축)
 *  · ack(motion 미상)          → excited (인사 기본값 — 의미를 모르면 가장 안전한 반응)
 *  · answer + **최애팀 답변**   → 응원 7종 순환 (하린아빠 2026-08-16 14:09)
 *  · picker / correction       → thinking (되묻는 중)
 *  · unavailable · motion=bored → bored (답하지 못함·거절)
 *  · null/unknown(legacy)      → swing / pitching 교대 — payload 없는 과거 답변도
 *    멈춰 있지 않게 한다(종전 idle 정지 폴백 대체).
 *
 * `motion` 은 서버가 §7.6 SSOT(`geniusMotionForResult`)로 계산해 payload 에 실은 값이다.
 * 그 계산을 여기서 재현하지 않는다 — 재현하면 두 곳이 조용히 갈라진다.
 */
export function geniusMotionClipFor(
  replyKind: GeniusReplyKind | null | undefined,
  messageId: number,
  context?: {
    /**
     * 서버가 §7.6 SSOT 로 계산해 payload 에 실은 감정 모션 — **쿨다운이 승인한 것**.
     * 인사=excited / 감사·칭찬=headspin / 거절=bored 의 **의미**가 여기 들어있다.
     */
    readonly motion?: GeniusMascotMotion | null;
    /**
     * 쿨다운과 무관한 §7.6 **의도**. 30초 내 재인사면 `motion` 은 비지만 intent 는 남는다.
     * 의미 판정은 intent 로 하고, 감정 클립을 실제로 **재생할지**는 motion 이 정한다.
     */
    readonly motionIntent?: GeniusMascotMotion | null;
    /** 답변이 다루는 구단의 canonical team id. 서버가 질문에서 해석해 payload 로 싣는다. */
    readonly answerTeamId?: number | null;
    /** 보고 있는 유저의 최애팀 id (프로필). */
    readonly favoriteTeamId?: number | null;
    /**
     * 답변 대상 선수의 역할 (서버 payload). 확정되면 교대 대신 역할 동작을 재생한다.
     * null/미상(legacy 포함)은 기존 교대 그대로다(fail-close).
     */
    readonly answerPlayerRole?: GeniusAnswerPlayerRole | null;
  },
): GeniusMotionClip {
  // 음수·부동소수로 음수 인덱스가 나오면 undefined 가 된다 — 정규화해 닫는다.
  const seed = Math.abs(Math.trunc(messageId)) || 0;
  if (replyKind === "picker" || replyKind === "correction") return "thinking";

  // ⚠️ `unavailable` 의 조기 반환을 **제거했다** (삼순 2026-08-16 ①).
  //    종전에는 여기서 곧장 bored 를 돌려줘, 그 경로만 쿨다운 판정을 건너뛰었다.
  //    "reply_kind 는 모션이 아니라 유형이니 무관하다"는 내 논리였지만, 결과적으로
  //    **거절 계열만 쿨다운을 우회**하는 예외가 하나 더 생기는 것이었다(bored 예외화와
  //    같은 축). 이제 아래 공통 경로에서 intent/granted 로 함께 판정한다.
  //
  // ── §7.6 의미 ────────────────────────────────────────────────────────────────
  //
  // 🔴 의미(intent)와 부여(granted)를 **분리해서** 읽는다.
  //    `motion` 하나만 보면, 30초 쿨다운(#1202)이 거절한 순간 payload 에서 motion 이
  //    사라지고 "감사"·"인사"·"범위 안내"가 전부 같은 폴백으로 무너진다
  //    (삼순 2026-08-16 P0 — 쿨다운 거절이 **실경로**인데 게이트가 항상 motion 을
  //    주입해 그 경로를 못 보고 있었다).
  //
  //    쿨다운의 목적은 *감정 반응 남용 억제*이지 **의미를 지우는 것이 아니다.** 그래서
  //      · intent + granted → 그 감정 클립 (감정 반응)
  //      · intent + 거절    → **중립 클립** (억제하되 다른 감정으로 바꾸지 않는다)
  //    로 나눈다. 거절됐다고 "고마워"에 신남을 붙이면 그게 더 나쁜 오답이다.
  //
  // ⚠️ **전 의미 공통 규칙이다 — bored 도 예외가 아니다** (삼순 2026-08-16 보완).
  //    직전 회차에서 "범위 안내(bored)는 감정이 아니라 상태 표시"라며 쿨다운 예외로
  //    뒀다가 철회했다. 그 판단 자체는 그럴듯했지만 **§7.4 계약을 리뷰 승인 없이
  //    바꾸는 것**이었다. 예외가 필요하다는 근거가 서면 그때 §7.4 를 정식으로 고친다.
  //    지금 필요한 것은 "오해를 만들지 않는 것"뿐이고, 중립 클립이 그걸 이미 만족한다.
  // `unavailable` 은 서버가 항상 bored 를 실어 보내는 유형이지만(scope_guide·blocked),
  // payload 가 없는 legacy 응답도 있다 — 그 경우 유형 자체가 의미이므로 intent 로 승격한다.
  // (예외가 아니라 **의미 해석**이다: 승격된 intent 도 아래 쿨다운 판정을 똑같이 탄다.)
  const intent = context?.motionIntent ?? context?.motion
    ?? (replyKind === "unavailable" ? "bored" : undefined);
  const granted = context?.motion ?? (replyKind === "unavailable" && !context?.motionIntent
    // legacy unavailable(payload 없음)은 쿨다운 원장이 없으니 억제 대상이 아니다.
    ? "bored" : context?.motion);

  if (intent === "excited" || intent === "headspin" || intent === "bored") {
    // 쿨다운이 승인했을 때만 감정 클립. 거절되면 중립(야구 동작)으로 **일괄** 억제한다.
    if (granted === intent) return intent;
    return NEUTRAL_ACK_CLIP;
  }

  // 의미를 모르는 ack(legacy payload) — 중립. 무작위로 고르면 감사에 신남이 붙는다.
  if (replyKind === "ack") return NEUTRAL_ACK_CLIP;

  // 최애팀 얘기일 때만 응원 7종 — 그 외엔 야구 동작(fail-close).
  if (isFavoriteTeamAnswer(context?.answerTeamId, context?.favoriteTeamId)) {
    return CHEER_CLIPS[seed % CHEER_CLIPS.length];
  }
  // 선수 역할이 확정된 답변 — 의미 있는 축이므로 시드 교대보다 앞서고, 응원(최애팀)보다는
  // 뒤다 — 응원은 "네 팀 얘기다"라는 더 강한 신호다(하린아빠 2026-08-16 14:09 유지).
  const role = context?.answerPlayerRole;
  if (role === "pitcher" || role === "batter") return ROLE_CLIPS[role];
  // answer + legacy(null/undefined/모르는 값) — 둘 다 야구 동작으로 살아있게 둔다.
  return ANSWER_CLIPS[seed % ANSWER_CLIPS.length];
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
  /**
   * 마스코트 모션 (§7.6). 서버가 smalltalk·거절 경로에서만 실어 보낸다.
   * 클라는 `geniusMotionFromPayload` 로만 읽는다 — 폐쇄집합 밖 값(미래 서버가 추가한
   * 새 모션)은 모션 없음으로 폴백하고 payload 전체를 무효화하지 않는다
   * (mascotStateForReplyKind 의 forward-compat 계약과 같은 축).
   */
  motion?: GeniusMascotMotion;
  /**
   * §7.6 **의도** 모션 — 쿨다운 승인과 무관하게 항상 실린다.
   *
   * `motion` 은 DB 쿨다운(#1202)이 승인해야 실린다. 그래서 30초 내 재인사에서는
   * `motion` 이 비고, 그 순간 "감사"·"인사"·"범위 안내"가 클라에서 **구분 불가**가
   * 된다(삼순 2026-08-16 P0). 쿨다운의 목적은 *감정 반응 남용 억제*이지
   * **의미를 지우는 것이 아니다.**
   *
   * 그래서 의미(intent)와 부여(granted)를 분리해 둘 다 싣는다:
   *   · intent 있음 + granted 있음 → 그 감정 클립
   *   · intent 있음 + granted 없음 → **중립 클립**(쿨다운 억제. 다른 감정으로 바꾸지 않는다)
   *   · intent 없음(legacy payload) → reply_kind 기본값
   */
  motion_intent?: GeniusMascotMotion;
  /** `reply_kind === "picker"` 일 때만. 클라가 선택 카드를 렌더한다. */
  picker_options?: GeniusPickerOption[];
  /**
   * 답변이 다루는 구단의 canonical team id.
   *
   * 응원 7종 재생 자격 판정에만 쓴다 — 유저 최애팀과 **exact 일치**할 때만 응원이 붙는다.
   * 구단이 특정되지 않는 답변(선수·룰·용어·복수 구단)에는 아예 실리지 않는다.
   * ⚠️ 팀명 문자열이 아니라 id 다. 표기 변형(`LG`/`엘지`/`트윈스`)으로 갈리지 않게.
   */
  answer_team_id?: number;
  /**
   * 답변 대상 선수의 역할 ("pitcher" | "batter"). 답변 모션을 포지션에 맞추는 데만 쓴다.
   * 선수가 특정 안 되거나(팀·룰·용어) 역할이 갈리면(투타 비교·동명이인) 아예 안 실린다.
   */
  answer_player_role?: GeniusAnswerPlayerRole;
  /** `reply_kind === "correction"` 일 때만. 서버가 발급한 exact 후보만 유저에게 제안한다. */
  correction_options?: string[];
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
 * 답변 payload 조립 (SSOT) — server.ts 인라인에서 뽑았다 (2026-08-15 모션 매핑 PR).
 *
 * 인라인이면 게이트가 실제 조립 경로를 못 태우고 문자열 검사로 밀린다(#1102 SSOT 추출과
 * 같은 축). 필드별 계약:
 *  · reply_kind 는 match_path 에서 파생(SSOT 표) — 호출부가 따로 계산하지 않는다.
 *  · question_message_id 는 **모든 답변**에 실는다(피드백 exact 결속).
 *  · motion 은 pipeline 이 정한 값만 그대로 실는다(§7.6 매핑은 pipeline 단일 지점).
 *  · 내부 메타(revision·crawledAt·asOf)는 절대 실지 않는다 (하린아빠 2026-08-05 P0).
 */
export function composeGeniusReplyPayload(
  result: {
    source: string;
    motion?: GeniusMascotMotion;
    /** 쿨다운 승인 여부와 무관한 §7.6 의도 모션. 의미는 항상 보존한다. */
    motionIntent?: GeniusMascotMotion;
    pickerOptions?: ReadonlyArray<{
      kboId: string; name: string; team: string | null; position: string | null; backNo: string | null;
    }>;
    correctionOptions?: readonly string[];
    sourceUrl?: string;
    /** 답변 대상 구단 canonical team id (응원 클립 자격). 호출부가 결정론 계산해 넘긴다. */
    answerTeamId?: number | null;
    /** 답변 대상 선수 역할 (모션 클립 자격). 호출부가 로스터 SSOT 로 결정론 계산해 넘긴다. */
    answerPlayerRole?: GeniusAnswerPlayerRole | null;
  },
  questionMessageId: number,
): GeniusReplyPayload {
  return {
    type: "baseball_genius_reply",
    reply_kind: replyKindForMatchPath(result.source),
    match_path: result.source,
    question_message_id: questionMessageId,
    ...(result.motion ? { motion: result.motion } : {}),
    ...(result.motionIntent ? { motion_intent: result.motionIntent } : {}),
    ...(typeof result.answerTeamId === "number" && Number.isFinite(result.answerTeamId)
      ? { answer_team_id: result.answerTeamId }
      : {}),
    // 폐쇄집합 값만 실는다 — null(미상)은 필드 자체를 안 실어 legacy 와 구분되지 않게 한다.
    ...(result.answerPlayerRole === "pitcher" || result.answerPlayerRole === "batter"
      ? { answer_player_role: result.answerPlayerRole }
      : {}),
    ...(result.pickerOptions
      ? {
        picker_options: result.pickerOptions.map((option) => ({
          kbo_id: option.kboId, name: option.name, team: option.team,
          position: option.position, back_no: option.backNo,
        })),
      }
      : {}),
    ...(result.correctionOptions ? { correction_options: [...result.correctionOptions] } : {}),
    ...(result.sourceUrl ? { source_url: result.sourceUrl } : {}),
  };
}

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

/**
 * payload 에서 모션을 읽는다 — **폐쇄집합 대조는 이 함수 하나뿐이다** (SSOT).
 * 모르는 값(미래 모션·외부 조작)은 null — 애니메이션이 안 붙을 뿐 화면은 그대로다.
 */
export function geniusMotionFromPayload(
  payload: GeniusReplyPayload | null | undefined,
): GeniusMascotMotion | null {
  const motion = payload?.motion;
  if (motion === undefined) return null;
  return (GENIUS_MASCOT_MOTIONS as readonly string[]).includes(motion)
    ? (motion as GeniusMascotMotion)
    : null;
}

/**
 * 쿨다운과 무관한 §7.6 **의도** 모션. 클립 선택은 이 값으로 의미를 판정한다.
 * (`geniusMotionFromPayload` 는 "부여됐는가"에 답한다 — 둘은 다른 질문이다.)
 */
export function geniusMotionIntentFromPayload(
  payload: GeniusReplyPayload | null | undefined,
): GeniusMascotMotion | null {
  const intent = payload?.motion_intent;
  if (intent === undefined) return null;
  return (GENIUS_MASCOT_MOTIONS as readonly string[]).includes(intent)
    ? (intent as GeniusMascotMotion)
    : null;
}

/**
 * payload 에서 답변 대상 선수 역할을 읽는다 — 폐쇄집합 대조는 이 함수 하나뿐이다 (SSOT).
 * 모르는 값(미래 역할·외부 조작)은 null — 교대 폴백으로 내려갈 뿐 화면은 그대로다.
 */
export function geniusAnswerPlayerRoleFromPayload(
  payload: GeniusReplyPayload | null | undefined,
): GeniusAnswerPlayerRole | null {
  const role = payload?.answer_player_role;
  if (role === undefined) return null;
  return (GENIUS_ANSWER_PLAYER_ROLES as readonly string[]).includes(role)
    ? (role as GeniusAnswerPlayerRole)
    : null;
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
  const obj = p as { type?: unknown; reply_kind?: unknown; match_path?: unknown; picker_options?: unknown; correction_options?: unknown; question_message_id?: unknown; source_url?: unknown };
  if (obj.type !== "baseball_genius_reply" || typeof obj.match_path !== "string") return false;
  if (
    obj.reply_kind !== "answer" && obj.reply_kind !== "ack" &&
    obj.reply_kind !== "unavailable" && obj.reply_kind !== "picker" && obj.reply_kind !== "correction"
  ) return false;
  // motion 은 문자열만 통과시킨다. 폐쇄집합 대조는 여기서 하지 **않는다** — 미래 서버가
  // 새 모션 값을 보내도 구 클라에서 payload 전체(마스코트·picker·피드백)가 죽으면
  // 안 된다. 값 해석은 `geniusMotionFromPayload` 가 폐쇄집합으로 닫는다.
  const motionField = (obj as { motion?: unknown }).motion;
  if (motionField !== undefined && typeof motionField !== "string") return false;
  const motionIntentField = (obj as { motion_intent?: unknown }).motion_intent;
  if (motionIntentField !== undefined && typeof motionIntentField !== "string") return false;
  // 선택지가 붙어 있으면 항목까지 검증한다 — 깨진 payload 로 카드를 그리면 빈 버튼이 난다.
  // 상한 초과도 거절한다(무한 목록 렌더 방지).
  if (obj.picker_options !== undefined) {
    if (!Array.isArray(obj.picker_options)) return false;
    if (obj.picker_options.length === 0 || obj.picker_options.length > GENIUS_PICKER_MAX_OPTIONS) return false;
    if (!obj.picker_options.every(isPickerOption)) return false;
  }
  // picker 라고 주장하면서 선택지가 없으면 렌더할 것이 없다 — 유효한 payload 가 아니다.
  if (obj.reply_kind === "picker" && obj.picker_options === undefined) return false;
  if (obj.correction_options !== undefined &&
      (!Array.isArray(obj.correction_options) || obj.correction_options.length !== 1 ||
       !obj.correction_options.every((value) => typeof value === "string" && value.length > 0 && value.length <= 200))) return false;
  if (obj.reply_kind === "correction" && obj.correction_options === undefined) return false;
  if ((obj.reply_kind === "picker" || obj.reply_kind === "correction") &&
      (!Number.isSafeInteger(obj.question_message_id) || Number(obj.question_message_id) < 1)) return false;
  // picker 가 아니어도 값이 실려 오면 형식을 검증한다 — 피드백이 이 값을 결속키로 쓰므로
  // 깨진 값이 통과하면 잘못된 질문에 평가가 붙는다.
  if (obj.reply_kind !== "picker" && obj.reply_kind !== "correction" && obj.question_message_id !== undefined &&
      (!Number.isSafeInteger(obj.question_message_id) || Number(obj.question_message_id) < 1)) return false;
  // 응원 자격 id — 값이 실려 오면 형식을 검증한다. 깨진 값이 통과하면 엉뚱한 팀 답변에
  // 응원이 붙는다. 없는 것(undefined)은 정상 — 구단이 특정 안 된 답변이 대부분이다.
  const answerTeamField = (obj as { answer_team_id?: unknown }).answer_team_id;
  if (answerTeamField !== undefined && !isRealTeamId(answerTeamField)) return false;
  // 역할은 문자열만 통과시킨다. 폐쇄집합 대조는 여기서 하지 **않는다** — motion 과 같은
  // forward-compat 계약이다(미래 역할 값이 구 클라 payload 전체를 죽이면 안 된다).
  const answerPlayerRoleField = (obj as { answer_player_role?: unknown }).answer_player_role;
  if (answerPlayerRoleField !== undefined && typeof answerPlayerRoleField !== "string") return false;
  // 입력이 외부에서 오므로 **allowlist hostname 을 실제 URL 파서로 대조**한다 (삼순 P0-2).
  // `https://` 접두 문자열 검사는 `https://namu.wiki@evil.com/` 같은 형태에 뚫리고,
  // 임의 외부 주소가 그대로 출처 링크가 되면서 `KBO 공식 자료` 라벨까지 달릴 수 있다.
  if (obj.source_url !== undefined &&
      (typeof obj.source_url !== "string" || resolveAllowedSource(obj.source_url) === null)) return false;
  return true;
}
