// 야구 용어/룰 질문 3단 파이프라인 (spec: specs/baseball-qa-mvp.md §2, §6)
// ①검수 사전(토큰 0) → ②동일질문 캐시 → ③flash-lite LLM(미매칭만).
// DB/LLM 접근은 deps로 주입 → route가 실제 구현, 스모크는 mock으로 검증.

import {
  isFollowupPhrase,
  selectContextTurn,
  selectDraftContextTurn,
  type ContextTurn,
  type PreviousTurnRow,
} from "./context";
import {
  asksDraftDetail,
  draftUnavailableReason,
  isDraftFollowupGrammar,
  isDraftQuestion,
  parseDraftLabel,
  renderDraftAnswer,
  renderDraftUnavailable,
} from "./roster/draft";
import { normalizeKey, normalizeQuestion } from "./normalize";
import {
  allowsNumericAnswer,
  composeRagAnswer,
  isDescriptivePlayerQuestion,
  RAG_ANSWER_MAX_CHARS,
  selectEvidence,
  validateRagResponse,
  type RagEntityCandidate,
  type RagEvidence,
  type RagNewsCandidate,
  type RagPlayerCandidate,
  type RagTeamCandidate,
} from "./rag/retrieve";
import { resolveNewsRecency, type NewsRecencyIntent } from "./rag/news-recency";
import { displayProvenanceOf } from "./genius-reply-provenance";
import {
  composeSeasonRecordAnswer,
  isServedOnlyMetric,
  RECORD_MISSING_ANSWER,
  resolveSeasonRecord,
  resolveSeasonRecordIntent,
  UNSUPPORTED_SEASON_ANSWER,
  UNTRUSTED_METRIC_ANSWER,
  type SeasonRecordRow,
} from "./stats/season-record";
import { crossCheckServedAgainstDb } from "./stats/served-record";
import {
  composeTeamRecordAnswer,
  isTeamScoreQuestion,
  resolveTeamRecord,
  resolveTeamRecordIntent,
  type TeamRecordFetchers,
} from "./stats/team-record";
import {
  BASEBALL_GENIUS_DAILY_LIMIT,
  BASEBALL_GENIUS_FALLBACK_ANSWER,
  BASEBALL_GENIUS_UNCLEAR_ANSWER,
  BASEBALL_GENIUS_SYSTEM_ERROR_ANSWER,
  BASEBALL_GENIUS_NAME_SUGGEST_ANSWER,
  BASEBALL_GENIUS_MAX_ANSWER_LENGTH,
  BASEBALL_GENIUS_MAX_QUESTION_LENGTH,
  BASEBALL_GENIUS_MIN_QUESTION_LENGTH,
} from "@/lib/constants/baseball-genius";

export const DAILY_LIMIT = BASEBALL_GENIUS_DAILY_LIMIT;
export const MIN_QUESTION_LEN = BASEBALL_GENIUS_MIN_QUESTION_LENGTH;
export const MAX_QUESTION_LEN = BASEBALL_GENIUS_MAX_QUESTION_LENGTH;

/**
 * ① 범위 밖 — **"야구 질문이 아니다"라고 확신할 때만** 쓴다 (하린아빠 2026-08-05).
 * 현재 쓰는 곳은 둘뿐이다:
 *   (a) 고정밀 범위밖 의도 denylist (`isOutOfScopeIntent`) — 문장 의도로 드러난 경우
 *   (b) LLM 2차 가드가 `NOT_BASEBALL` 로 **명시 판정**한 경우
 * 그 밖의 실패(이해 못함·근거 없음·시스템 오류)은 ② `UNCLEAR_ANSWER` 로 간다.
 */
export const BLOCKED_ANSWER = BASEBALL_GENIUS_FALLBACK_ANSWER;
/**
 * ② 이해 못함 — 주제는 야구가 맞는데(또는 아니라고 확신할 근거가 없는데)
 * 우리가 답을 만들지 못한 경우. 유저가 다시 물으면 될 수 있다는 사실을 전한다.
 *
 * 운영 로그 실측(2026-08-05): 미답변 1,075건의 대다수가 이 칸에 속했는데
 * 전부 ① 문구로 나갔다 — 야구 질문을 한 유저에게 "야구 질문만 하라"고 답한 꼴이다.
 */
export const UNCLEAR_ANSWER = BASEBALL_GENIUS_UNCLEAR_ANSWER;
/**
 * ④ 이름 교정 제안 — 로스터에 없는 실명이지만 한 글자만 다른 선수가 정확히 1명일 때.
 * `임창규` → `혹시 임찬규 선수를 말씀하신 건가요?` (2026-08-08 하린아빠 제보).
 */
export const NAME_SUGGEST_ANSWER = BASEBALL_GENIUS_NAME_SUGGEST_ANSWER;
/**
 * ⑤ 미결속 실명 — 로스터에 없고 가까운 후보도 없을 때(`오타니`·`홍길동`).
 * 제안할 이름이 없어도 **생성은 막는다** — 그게 삼순 2026-08-08 P0 의 핵심이다.
 */
/**
 * ③ 시스템 오류 — **우리 쪽이 고장난** 경우 전용.
 *
 * ②와 합치면 안 되는 이유(삼순 2026-08-08 ①): RPC·LLM 이 죽어서 못 답한 걸
 * "질문을 정확히 이해하지 못했어요" 로 말하면 유저는 자기 문장을 탓하며 고쳐 쓴다.
 * 고칠 게 없는데 헛수고를 시키는 것이고, 우리 장애도 유저 눈에 안 보인다.
 *
 * ⚠️ `source === "error"` 인 모든 반환은 이 문구를 쓴다 — 하나라도 다른 문구가 섞이면
 * 3분기 계약이 그 경로에서만 조용히 깨진다(게이트가 경로별 actual 로 대조한다).
 */
export const SYSTEM_ERROR_ANSWER = BASEBALL_GENIUS_SYSTEM_ERROR_ANSWER;
// LLM이 야구 질문인지 확신하지 못한 경우 — 차단 문구가 아니라 확인 질문이다.
//
// ⚠️ 2026-08-08 문구 현행화 + 예시 추가. 운영 로그 실측(최근 3일 미답변 196건)에서
// `야구 룰`·`야구 규칙`·`야구 룰 알려줘` 같은 **범위를 그대로 되물은** 질문이 16건이었다.
// 봇이 "야구 룰 질문만 답할 수 있어요"라고 안내해 놓고 유저가 `야구 룰`이라고 치면
// 다시 되묻기만 하니 유저는 다음에 뭘 해야 할지 알 수 없다. 되물을 때는 **무엇을 물으면
// 되는지 실제 예시**를 준다.
export const UNSURE_ANSWER =
  "어떤 걸 여쭤보신 걸까요? 조금만 더 구체적으로 적어주시면 정확히 답해드릴게요. " +
  "예: \"보크가 뭐야?\" \"3피트 룰 알려줘\" \"LG 요즘 어때?\" ⚾";
/**
 * `<X> <지표>` 되묻기 전용 문구.
 *
 * ⚠️ `UNSURE_ANSWER`("어떤 걸 여쭤보신 걸까요?")를 재사용하지 않는다. 유저는 이미
 *   **무엇을 물을지 정해서** 왔다(`이대호 홈런`). 되물어야 하는 건 "무엇"이 아니라
 *   그 대상을 우리가 못 찾는다는 사실이다. 같은 문구를 보내면 유저는 자기가 질문을
 *   덜 썼다고 오해하고 같은 문장을 반복한다.
 *
 * ⚠️ **선수라고 단정하지 않는다**(2026-08-08 전건 감사 실측). 이 경로로 오는 문장은
 *   `이대호 홈런`(미등록 인물)과 `루킹 삼진이 뭐야`(미수록 용어)가 **구조적으로 구분
 *   불가능**해서 함께 온다. "어떤 선수의 기록을 말씀하시는 걸까요?" 라고 물으면 용어를
 *   물은 유저에게 틀린 되묻기를 보내게 된다 — 좁게 말한 사고(#1108)를 방향만 바꿔
 *   반복하는 것이다. 그래서 두 가능성을 **둘 다 열어** 되묻고, 각각의 다음 행동을 준다.
 *
 * 왜 이 경로가 필요한가 — `이대호 홈런` 은 운영 DB 에 없는 대상이라 LLM 으로 내려보내면
 * 없는 기록을 지어낸다. 되묻기로 종결해 생성 경로를 끊는다.
 */
export const STAT_CLARIFY_ANSWER =
  "앞말이 선수 이름인지 야구 용어인지 제가 확인하지 못했어요. " +
  "현역 선수라면 이름을 정확히, 용어라면 붙여서(예: 만루홈런) 다시 여쭤봐 주시면 찾아볼게요! ⚾";
export const SERVICE_REDIRECT_ANSWER =
  "크보팬 서비스 관련 문의는 마이페이지 > 피드백 보내기로 보내주시면 운영팀이 확인해요! 저는 야구 이야기를 도와드릴게요 ⚾";
/**
 * **지원 allowlist 밖 지표** 전용 안내.
 *
 * ⚠️ 이전 문구(`선수나 구단 기록은 제가 아직 정확히 답해드리기 어려워요 … 앱의 기록 탭`)는
 * 하린아빠가 2026-08-04 18:26 에 **더 나오면 안 된다**고 명시했다. 이제 선수 서술형은
 * RAG 가, 시즌 기록은 `kbo_structured` 가 실제로 답하기 때문에 "기록은 못 합니다"는
 * **거짓말**이 됐다.
 *
 * 그럼 왜 이 문구가 아직 필요한가 — 운영 DB 실측(2026-08-04):
 *   batter: avg games pa ab runs hits doubles triples hr tb rbi sac sf
 *   pitcher: era games wins losses saves holds wpct ip h hr bb hbp so r er whip
 * **도루(sb)·출루율·장타율·OPS 컬럼이 아예 없다.** allowlist 에 넣어도 가져올 값이 없고,
 * LLM 에 넘기면 숫자를 지어낸다. 그래서 **못 답하는 것은 그대로 못 답한다고 말하되**,
 * "기록 전반"이 아니라 **그 지표**만 못 답한다고 범위를 정확히 밝히고, 답할 수 있는
 * 지표를 같이 안내해 유저가 다음 행동을 할 수 있게 한다.
 */
export const HISTORY_HOLD_ANSWER =
  "그 기록은 아직 준비되지 않았어요. 지금은 2026 시즌의 타율·홈런·타점·안타·경기·루타, " +
  "방어율·승·패·세이브·홀드·탈삼진·이닝 같은 기록을 답해드릴 수 있어요! ⚾";

/**
 * **구단 단위 수치** 전용 fail-close 안내 (삼순 #1100 2차 P0-2).
 *
 * 왜 필요한가 — `LG 팀타율`·`두산베어스 홈런 몇 개`·`KIA 순위`는 구단 질문이라
 * 답변 범위 안이지만, **팀 단위 집계를 담은 정본 DB 가 없다**. 그대로 generic LLM 으로
 * 보내면 모델이 기억으로 숫자를 지어낸다(환각). 프롬프트의 근거없음 계약은 두 번째
 * 방어선일 뿐이고, 첫 번째 방어선은 애초에 보내지 않는 것이다.
 *
 * 선수 미지원 지표(`HISTORY_HOLD_ANSWER`)와 같은 모양으로 **못 하는 것은 못 한다고 말하되**
 * 답할 수 있는 범위를 같이 밝혀 유저가 다음 행동을 할 수 있게 한다.
 */
export const TEAM_STAT_HOLD_ANSWER =
  "팀 단위 기록(팀 타율·팀 홈런·현재 순위 같은 수치)은 정확한 자료가 없어 말씀드리기 어려워요. " +
  "순위·팀 기록은 홈의 순위표에서 바로 보실 수 있고, 구단 이야기나 선수 기록은 제가 답해드릴게요! ⚾";

/**
 * 최신 소식을 물었는데 그 창의 기사 근거로 답을 못 만든 경우 (삼순 조건부 GO ②).
 *
 * ⚠️ `BLOCKED_ANSWER`를 쓰지 않는 이유: 기본 차단문은 "야구 룰/용어만 답할 수 있어요" 라고
 * 말하는데, 그건 **거짓말이다** — 질문은 범위 안이었고 단지 그날 기사가 없었을 뿐이다.
 * 유저가 다음에 뭐를 할 수 있는지(다른 날·다른 질문)를 남긴다.
 */
export const NEWS_UNAVAILABLE_ANSWER =
  "그 시기 기사에서는 답드릴 만한 내용을 찾지 못했어요. " +
  "기간을 조금 달리해서(예: ‘최근 LG 어때?’) 다시 물어보시면 찾아볼게요! ⚾";
// 후속형인데 이어붙일 직전 turn이 없을 때 — 차단 문구가 아니라 정중한 되묻기다 (spec §4.3 AC4).
export const CONTEXT_MISSING_ANSWER =
  "어떤 내용에 이어서 여쭤보시는 걸까요? 궁금한 걸 한 번만 더 적어주시면 답해드릴게요! ⚾";

export const LLM_AMBIGUOUS_ANSWER =
  "답변을 저장하는 과정에서 문제가 생겨 이번 질문에는 답을 드리지 못했어요. 같은 질문을 다시 보내주시면 새로 답해드릴게요! ⚾";

/**
 * **범위 되묻기 안내** — `야구 룰`처럼 "뭔가 되느냐"를 물은 경우.
 *
 * 왜 되물지 않는가 — 이 질문은 **우리 안내문이 만든 질문**이다. 봇이 "야구 룰 질문만
 * 답할 수 있어요"라고 말해놓고 유저가 `야구 룰`이라고 치면 다시 되묻는 건,
 * 안내를 따른 사람을 벌주는 것이다(운영 로그 최근 3일 16건).
 *
 * ⚠️ 문구는 `ANSWER_PATH_SCOPE_WORD` SSOT 의 범위어를 **전부** 담는다 — 게이트가
 * 대조하므로 새 답변 경로가 생기면 이 문구도 같이 늘어나야 빌드가 통과한다.
 * 그리고 **바로 물을 수 있는 예시**를 같이 준다 — 범위만 나열하면 유저는 또 뭔가를
 * 골라야 하고, 그 고르는 부담 때문에 그냥 나간다.
 */
export const SCOPE_GUIDE_ANSWER =
  "제가 답해드릴 수 있는 건 이런 거예요 — 야구 룰·용어, 구단 이야기, 선수, 일부 기록, 그리고 최근 소식이요. " +
  "어떤 걸 물어볼지 고르셔도 되고(예: \"보크가 뭐야?\" \"3피트 룰 알려줘\" \"LG 어떤 구단이야?\" " +
  "\"김도영 타율\" \"요즘 삼성 어때?\"), 궁금한 걸 그냥 적어주셔도 찾아볼게요! ⚾";
// 직전 답변에 대한 감사·확인 인사 — 질문이 아니라 대화 행위다. 차단 문구를 보내면 안 된다.
export const ACK_ANSWER = "도움이 됐다니 다행이에요! ⚾";
// 대화 첫 턴 인사 — 질문이 아니라 대화 시작이다. 차단 문구를 보내면 문전박대가 된다.
// ⚠️ ACK_ANSWER("도움이 됐다니 다행이에요")를 재사용하면 안 된다: `안녕` 에 그 문구가 나가면
//    아무 도움도 준 적 없이 도움이 됐다고 말하는 꼴이라 대화가 어긋난다.
//    같은 `ack` 경로를 타되 답변 문구만 갈린다.
//
// ⚠️ **맞이하는 문구로 쓰지 않는다**(삼순 2026-08-08 NO-GO).
//    한국어 `안녕` 은 만남·헤어짐에 둘 다 쓰인다 — 대화를 마치면서 `안녕` 을 친 사람에게
//    `안녕하세요!` 로 답하면 또 어긋난다. 즉 "첫 턴 인사"라는 해석에는 반대가설이 있고,
//    반대가설이 있는 건 코드가 단정하면 안 된다(2026-08-07 확정 원칙).
//    그래서 **만남·헤어짐 양쪽에 다 자연스러운 중립 문구**를 쓴다.
export const GREETING_ANSWER =
  "안녕! 야구 이야기가 궁금할 때 언제든 불러 주세요 ⚾";
// 하루 한도 소진 안내 — 질문에 대한 답이 아니라 상태 고지다.
// 인라인 템플릿으로 두면 "고정 문구"로 식별되지 않아 분류 게이트가 실답변으로 오판한다.
export const LIMITED_ANSWER = `오늘 질문 한도(${DAILY_LIMIT}개)를 다 썼어요. 내일 다시 물어봐 주세요!`;

/**
 * 동명이인 picker 안내 문구.
 *
 * 클라이언트는 payload로 선택 카드를 렌더하지만, payload를 모르는 구버전·알림 미리보기는
 * 이 텍스트만 보게 된다. 그래서 문구 단독으로도 상황이 전달되게 쓴다.
 */
export const PLAYER_PICKER_ANSWER =
  "같은 이름의 선수가 여럿 있어요. 어느 선수를 말씀하시는 건가요?";

/**
 * 단독 감사·확인 인사 폐쇄집합 (삼순 GO / 신기능 B).
 * `고마워`처럼 직전 답변에 대한 대화 행위는 야구 질문이 아니지만 차단 대상도 아니다.
 * 폐쇄집합 **full-string 완전일치**만 ACK로 분기한다 — substring 매칭을 하면
 * `고마운데 주식 추천해줘`처럼 감사 뒤에 새 요청이 붙은 문장이 판정을 우회한다.
 */
const ACK_PHRASES = [
  "고마워", "고마워요", "고마웠어", "고맙습니다", "고맙다",
  "감사", "감사해", "감사해요", "감사합니다", "감사드립니다",
  "ㄳ", "ㄱㅅ", "땡큐", "땡스", "thx", "thanks", "thank you",
  "잘 알겠어", "잘 알겠어요", "알겠어", "알겠어요", "알겠습니다",
  "이해했어", "이해했어요", "이해됐어", "이해됐어요",
  // 반응어 (2026-08-10 하린아빠 캡처 — `ㅇㅋ` 가 범위 안내를 받았다). 직전 답변을
  // 수긍하는 대화 행위라 감사 인사와 같은 칸이다. full-string 완전일치만 잡으므로
  // `ㅇㅋ 근데 보크는?` 같은 복합문은 여기 안 걸린다. 반대가설 없는 폐쇄집합.
  // ⚠️ 넣지 않는 것: `ㄴㄴ`(부정어 — 수긍이 아니다), `ㅋㅋ`·`ㅎㅎ`(normalizeAck 가 말몸 ㅋ/ㅎ 를
  // 전부 벗겨 **빈 문자열**이 된다 — 빈 문자열을 집합에 넣으면 `??` 같은 순수 구두점도 ack 으로 접힌다).
  "ㅇㅋ", "ㅇㅋㅇㅋ", "오케이", "오키", "ok", "okay", "ㅇㅇ", "넵", "네", "응", "굿", "굿굿",
] as const;

/** 앞뒤 공백 제거 · 중복 공백 축약 · 문말 구두점 제거 · 소문자 · NFC */
function normalizeAck(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?!.,~…♡❤⚾🙏😊ㅎㅋ]+$/u, "")
    .trim();
}

/**
 * 단독 인사말 폐쇄집합 (2026-08-07, production 로그 실측).
 *
 * 왜 필요한가 — 최근 3일 답변불가 163건 중 **14건(8.6%)이 인사말**이고, 전기간 누적으로는
 * `안녕` 단독이 **31회로 답변불가 1위**였다. 인사를 건네면 봇이
 * `"야구 룰/용어에 대한 질문만 답할 수 있어요"` 를 되돌려줘서, 대화 첫 턴부터 문전박대를 맞는다.
 *
 * 왜 코드로 두는가 (2026-08-07 확정 원칙: "반대가설을 만들 수 없는 것만 코드로")
 *   `안녕` 단독을 인사 아닌 무언가로 읽는 반례를 만들 수 없다. ACK 와 동일하게
 *   **full-string 완전일치**만 잡으므로 `안녕 보크가 뭐야` 는 여기 안 걸리고 기존 판정으로 간다.
 *
 * ⚠️ 새 `match_path` 를 만들지 않고 `ack` 경로를 재사용한다.
 *   둘 다 "질문이 아닌 대화 행위"라 라우팅 의미가 같고, 새 값을 만들면 CHECK migration +
 *   피드백 allowlist + 마스코트 분류 + 게이트까지 4곳을 함께 등록해야 한다(team_rag 실측).
 *   감사와 인사를 나눠 세야 할 때는 `question` 원문이 로그에 남으므로 사후 집계로 충분하다.
 */
const GREETING_PHRASES = [
  "안녕", "안녕요", "안녕하세요", "안녕하십니까", "안녕하세용",
  "안녕하셔요", "안녕하세", "안녕안녕", "안뇽", "안욘", "아뇽",
  "하이", "하잉", "하이하이", "헬로", "헬로우",
  "hi", "hello", "hey", "ㅎㅇ", "ㅎㅇㅎㅇ", "ㅎㅇ요",
  "반가워", "반가워요", "반갑습니다", "반갑다",
  // ⚠️ `안녕히` 는 뺀다(삼순 2026-08-08) — 운영 로그에 단독 출현 근거가 없다.
  //    근거 없는 항목을 폐쇄집합에 넣으면 그만큼 오분류 면적만 넓어진다.
  "여보세요", "굿모닝", "좋은아침", "좋은 아침",
] as const;

const ACK_SET = new Set(ACK_PHRASES.map(normalizeAck));
const GREETING_SET = new Set(GREETING_PHRASES.map(normalizeAck));

/**
 * 단독 인사말인지 (폐쇄집합 full-string 완전일치).
 * `안녕 보크가 뭐야` 처럼 인사 뒤에 질문이 붙으면 여기 안 걸리고 정상 판정을 타 답변된다.
 */
export function isGreetingPhrase(question: string): boolean {
  return GREETING_SET.has(normalizeAck(question));
}


/**
 * 단독 감사·확인 인사인지 (폐쇄집합 full-string 완전일치).
 * 뒤에 새 요청절이 붙은 문장(`고마워 근데 날씨 알려줘`)은 일치하지 않으므로 기존 판정으로 간다.
 */
export function isAckPhrase(question: string): boolean {
  return ACK_SET.has(normalizeAck(question));
}

/**
 * **범위 되묻기**(메타 질문) 판정.
 *
 * 사고 — 봇이 `야구 룰·용어 질문만 답할 수 있어요` 라고 안내해 놓고, 유저가 그 안내를
 * 그대로 따라 `야구 룰` 이라고 치면 다시 되물었다. 운영 로그 실측(최근 3일 미답변
 * 196건) 중 **16건**이 이 모양이었다. 안내문을 따른 유저를 벌주는 꼴이다.
 *
 * ⚠️ **어휘 열거로 풀지 않는다.** 처음엔 문장을 폐쇄집합으로 적었는데, 게이트가 바로
 * `야구 룰은 뭔가있어?`·`야구 룰 간단하개`(오타)를 놓치는 걸 잡았다. 유저의 문장은
 * 무한히 변형되므로 열거하는 순간 지는 싸움이다(#1112 에서 사전을 손으로 채우다
 * 접은 것과 같은 이유).
 *
 * 대신 **구조**로 판정한다: "범위어와 의문문 꺼풀을 걷어냈을 때 남는 게 없는가".
 *
 *   야구 룰은 뭔가 있어?      → [야구][룰][뭔가][있어]      → 남는 것 없음  → 범위 되묻기
 *   야구 룰 중에 보크가 뭐야?  → [야구][룰][뭐야] + **보크**  → 남음        → 진짜 질문
 *
 * 즉 "무엇을 물었는가"가 비어 있을 때만 되묻기 대신 범위를 안내한다. 이 모양은
 * 오타·어미·어순이 바뀜도 유지된다 — 새 표현마다 목록을 늘리지 않아도 된다.
 *
 * ⚠️ substring 으로 `야구 룰`을 잡지 않는다 — 그러면 진짜 용어 질문까지 안내문으로
 *   덮는다(#1127 4차 NO-GO 의 `SCORE_CONTEXT_HEADS` 전역 substring 과차단과 같은 실수).
 */

/** 범위 자체를 가리키는 말 — 이것만 있으면 "뭔가 되느냐"를 물은 것이다. */
const SCOPE_META_WORDS = [
  "야구", "구야", "룰", "규칙", "용어", "kbo", "프로야구", "야구경기",
  "너", "니", "봇", "야잘알봇", "답변", "대답",
  // "뭐 물어볼 수 있어" 류 — 물음 그 자체를 대상으로 삼은 메타 질문이다.
  // 꺼풀이 아니라 메타어로 둔다 — 이게 없으면 문장이 통째로 꺼풀만 남아
  // "범위어가 없다"로 분류돼 안내문이 안 나간다.
  "물어볼", "물어봐", "물어", "여쭤", "질문",
];

/**
 * 의문문 꺼풀 — 물음의 **형식**일 뿐 물은 대상이 아니다.
 * 어미·조사는 아래 `isParticleOnly` 가 따로 처리하므로 여기엔 어간만 둔다.
 *
 * ⚠️ **두 칸으로 나눈 이유** (삼순 2026-08-08 조건 ② — `볼`·`야수` 과차단).
 * 처음엔 한 목록을 통째로 `replace(/…/g)` 로 지웠는데, 한 글자 꺼풀(`야`·`수`·`볼`)이
 * **야구 용어 안에서 조각으로 걸려** 진짜 질문을 통째로 녹였다:
 *
 *   야수가  → [야][수] + 조사 `가`  → "남은 게 없다" → 범위 되묻기로 오판
 *   볼이    → [볼]     + 조사 `이`  → 같은 방식으로 오판
 *
 * `야수`·`볼`은 사전에 실제로 있는 용어다(운영 로그에도 `야수가 뭐야`가 있다).
 * 그래서 **한 글자 꺼풀은 토큰 전체와 정확히 같을 때만** 꺼풀로 인정하고,
 * 붙여쓰기 해체(`뭔가있어`)에는 두 글자 이상만 쓴다. 그리고 `볼`처럼 **용어와
 * 충돌하는 한 글자는 아예 꺼풀에서 뺀다** — `볼 카운트`의 그 볼이다.
 */
/** 붙여쓴 모양까지 해체하는 데 쓰는 꺼풀 (2자 이상만). */
const SCOPE_ASK_FILLERS_MULTI = [
  "뭔가요", "뭔가", "뭐가", "뭐야", "뭐예요", "무엇", "뭔데", "뭔지", "인가요", "일까",
  "어떤", "어떻게", "어떨",
  "알려줘", "알려주", "알려", "알아",
  "설명해줘", "설명해", "설명", "가르쳐줘", "가르쳐",
  "있을까", "있는지", "있어요", "있어", "있나", "있는",
  "가능", "되나",
  "간단하게", "간단하개", "간단히", "간단", "간략히", "간략",
  "쉬운거", "쉬운", "쉬게", "자세히", "자세한",
  "전부", "모두", "모든", "좀더",
  "주세요", "주실", "해줘", "할까",
];
/**
 * **토큰 전체와 같을 때만** 꺼풀로 치는 한 글자.
 *
 * ⚠️ 여기에 `볼`·`야`·`수`·`해` 같은 **용어 조각**을 넣지 않는다. 넣는 순간
 * `볼이 뭐야?`·`야수가 뭐야?` 가 범위 안내문에 먹힌다(위 주석의 실측 사고).
 * 한 글자는 어차피 단독으로 왔을 때만 의미가 있다 — `뭐 할 수 있어` 의 `할`·`수`.
 */
const SCOPE_ASK_FILLERS_SINGLE = [
  "뭐", "뭔", "할", "수", "줘", "줄", "좀", "더", "다", "돼", "되",
];

const SCOPE_META_SET = new Set(SCOPE_META_WORDS);
const SCOPE_SINGLE_FILLER_SET = new Set(SCOPE_ASK_FILLERS_SINGLE);

/**
 * 꺼풀을 **붙여쓴 모양까지** 벘겨내기 위한 정규식(긴 것 우선).
 *
 * `뭔가있어`·`알려줄수있어` 처럼 띄어쓰기가 무너진 문장이 실제 로그에 많아,
 * 토큰 단위 집합 비교만으로는 `뭔가있어` 를 놓친다(게이트가 실제로 잡았다).
 */
const SCOPE_FILLER_RE = new RegExp(
  [...SCOPE_ASK_FILLERS_MULTI].sort((a, b) => b.length - a.length).join("|"),
  "gu",
);

/**
 * 메타어를 **긴 것부터** 떼어낸다.
 *
 * ⚠️ 삼순 2026-08-08 조건 ② — `프로야구 규칙` 누락. 선언 순서대로 떼면
 * `프로야구` 에서 `야구` 가 먼저 잘려 **`프로` 라는 유령 잔여**가 남고,
 * 그 잔여가 "물은 대상이 있다"로 읽혀 범위 되묻기 판정이 뒤집혔다.
 * 잔여를 만들지 않으려면 부분문자열을 포함하는 긴 어휘를 먼저 떼야 한다.
 */
const SCOPE_META_WORDS_LONGEST_FIRST = [...SCOPE_META_WORDS].sort((a, b) => b.length - a.length);

/** 조사 꼬리 — 긴 것 우선으로 써야 `에는` 이 `는` 으로 잘리지 않는다. */
const PARTICLE_TAIL_RE =
  /(?:에는|에서|으로|부터|까지|처럼|만큼|밖에|이랑|하고|은|는|이|가|을|를|에|도|만|랑|과|와|의|로)$/u;

/**
 * 범위어·꺼풀을 떼고 남은 꺼데기가 **조사만**인지.
 *
 * 한국어는 `룰은`·`뭔가있어` 처럼 붙어 오기 때문에, 메타어/꺼풀을 도려낸 뒤에도
 * `은`·`가` 같은 자수기가 남는다. 그걸 "남은 내용"으로 세면 `야구 룰은 뭔가있어?` 같은
 * 명백한 범위 되묻기가 진짜 질문으로 오판된다(게이트가 실제로 잡은 결함).
 */
function isParticleOnly(residue: string): boolean {
  let rest = residue;
  while (rest) {
    const next = rest.replace(PARTICLE_TAIL_RE, "");
    if (next === rest) return false;
    rest = next;
  }
  return true;
}

/**
 * 범위 되묻기인지 — **구조 판정**(어휘 열거 아님).
 *
 * ⚠️ 이 함수가 `true` 를 돌려도 그것만으로 답이 바뀌지 않는다 — 안내문은
 * `SCOPE_GUIDE_ANSWER` 가 담당하고, 그 문구는 `ANSWER_PATH_SCOPE_WORD` SSOT 와
 * 게이트에서 대조된다. 범위가 늘면 문구도 같이 늘어나야 빌드가 통과한다.
 */
export function isScopeAskPhrase(question: string): boolean {
  const normalized = normalizeAck(question).replace(/[?!.,~…]/gu, " ");
  const rawTokens = normalized.split(/\s+/u).filter(Boolean);
  if (rawTokens.length === 0) return false;

  let sawMeta = false;
  let sawRemainder = false;
  for (const raw of rawTokens) {
    // 붙여쓴 모양(`야구룰`·`야구규칙`)도 같은 판정을 받아야 한다.
    //
    // ⚠️ 여기서 조사를 먼저 떼지 않는다. 초기 구현은 `stripParticles(raw)` 를 거쳤는데
    //   mutation 으로 그 함수를 통째로 무력화해도 15케이스 전수 결과가 동일했다
    //   (= 반증 불가능한 죽은 코드). 아래 `isParticleOnly` 가 이미 자수기를 다 처리하므로
    //   제거했다 — 검증할 수 없는 분기를 남기면 다음 사람이 그걸 계약으로 오독한다.
    let token = raw;
    let matchedMeta = false;
    // 한 토큰이 메타어 여러 개를 붙인 경우(`야구룰`)를 벘겨낸다.
    // 긴 것부터 떼야 `프로야구` 가 `프로` + (야구) 로 쪼개지지 않는다.
    for (const meta of SCOPE_META_WORDS_LONGEST_FIRST) {
      if (token.includes(meta)) {
        token = token.split(meta).join("");
        matchedMeta = true;
      }
    }
    if (matchedMeta) sawMeta = true;
    if (SCOPE_META_SET.has(token)) {
      sawMeta = true;
      continue;
    }
    // 한 글자 꺼풀은 **토큰 전체와 같을 때만** 인정한다 (`뭐 할 수 있어` 의 `할`·`수`).
    // 조각으로 허용하면 `야수가`·`볼이` 같은 용어가 통째로 녹는다.
    if (SCOPE_SINGLE_FILLER_SET.has(token)) continue;
    // 꺼풀을 전부 떼어내고 남는 게 조사뿐이면 그 토큰은 "물음의 형식"일 뿐이다.
    if (isParticleOnly(token.replace(SCOPE_FILLER_RE, ""))) continue;
    // 범위어도 꺼풀도 아닌 무언가가 남았다 = 물은 대상이 있다 = 진짜 질문이다.
    sawRemainder = true;
    break;
  }
  return sawMeta && !sawRemainder;
}

/** LLM 판정 계약 (spec: 야구 룰/용어 판정 3분기). */
export const RULE_TERM_SENTINEL = "BASEBALL_RULE_TERM";
export const NOT_BASEBALL_SENTINEL = "NOT_BASEBALL";
export const UNSURE_SENTINEL = "UNSURE";
/** 구 프롬프트가 쓰던 status 값 — RULE_TERM과 동일 의미로 매핑한다 (in-flight 응답 호환). */
export const LEGACY_ANSWER_SENTINEL = "ANSWER";

export interface GlossaryEntry {
  term: string;
  aliases: string[];
  answer: string;
}

/**
 * 동명이인 picker 선택지 1개.
 *
 * 로스터 880명 중 32그룹 72명이 동명이인이고, 그중 7그룹은 **같은 팀에도** 동명이인이
 * 있다(김민준·김태훈·김현수·박준영·이서준·이승현·이주형). 따라서 "팀"만으로는 몳 가리고
 * 이름+팀+등번호까지 보여줘야 유저가 구분할 수 있다(이 3조합은 로스터에서 유일함을 실측).
 * 최종 특정은 표시값이 아니라 `kboId`로 한다.
 */
export interface PlayerPickerOption {
  kboId: string;
  name: string;
  team: string | null;
  position: string | null;
  backNo: string | null;
}

export interface PlayerRef {
  name: string;
  kboId: string;
  /**
   * 동명이인 picker 전용 보조 식별자. 선택지를 사람이 구분할 수 있게 보여주고,
   * 재질의 문장에서 어느 선수인지 다시 해석하는 데 쓴다. 없으면(미주입) 기존 동작 그대로다.
   */
  team?: string | null;
  position?: string | null;
  backNo?: string | null;
  /**
   * KBO 공식 프로필 `lblDraft` **원문**(예 `11 LG 1라운드 2순위`).
   *
   * ⚠️ 여기 원문을 두고 해석은 `roster/draft.ts` 한 곳에서만 한다 — 파싱이 두 곳에
   *   있으면 한쪽만 고쳐져 값이 갈린다.
   * ⚠️ `""`(공식에 등록 없음)과 `undefined`(아직 안 긁음)는 **다른 상태**다.
   */
  draft?: string | null;
}

export interface LlmResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type QuestionRoute =
  | "service_redirect"
  | "history_hold"
  | "blocked"
  | "context_missing"
  | "ack"
  // 범위 되묻기(`야구 룰`·`뭐 물어볼 수 있어`) — 질문이 아니라 우리 안내문에 대한 반응이다.
  //
  // ⚠️ 이 라벨은 `match_path` 로도 **그대로** 기록된다(`MatchPath` 에 같은 이름이 있다).
  // 그래서 DB CHECK 확장 migration 이 필요하다 — `20260808120000_*` 가 그것이다.
  | "scope_guide"
  // `<X> <지표>` 에서 X 를 운영 데이터로 특정하지 못해 되물은 경로 (삼순 2026-08-08).
  //
  // ⚠️ 기존 `unsure` 에 접지 않는다. `unsure` 는 이미 **LLM 이 답을 확신 못 한 경우**다.
  //   한 칸에 넣으면 "생성 품질 문제"와 "결속 데이터 부재 문제"가 섞여 분모가 사라진다.
  //   `team_rag`·`news_rag`·`scope_guide` 를 나눈 것과 같은 축이다.
  //   → `MatchPath` 에도 같은 이름이 있고 CHECK 확장 migration 이 필요하다
  //     (`20260809150000_*`).
  | "stat_clarify"
  // 구단 수치 질문 — 종결 라우트가 아니라 **조회 위임**이다. `answerQuestion` 이 순위표·팀기록을
  // 조회해 답하고, 미지원 지표·조회 실패만 fail-close 한다.
  //
  // ⚠️ 이 라벨로는 로그를 쓰지 않는다 — 성공은 `kbo_structured`, 실패는 `history_hold`/`error` 로
  // 확정된다. 전부 기존 `match_path` 허용값이라 DB CHECK 확장·migration 이 필요 없다.
  | "team_record"
  // 실측된 이름 오타(`임창규`) — 생성 없이 그 이름을 되묻는다.
  | "name_suggest"
  | "baseball_rule_term"
  // 룰베이스가 야구인지 아닌지 확정하지 못한 나머지 — 종결하지 않고 LLM 범위판정에 위임한다.
  // 이 라벨로는 로그를 쓰지 않는다(아래 answerQuestion에서 dictionary/cache/llm/blocked/unsure 중
  // 하나로 반드시 확정되므로 match_path CHECK 확장이 필요 없다).
  | "llm_scope_gate";
export type MatchPath =
  | "dictionary"
  | "cache"
  | "llm"
  | "service_redirect"
  | "history_hold"
  | "blocked"
  | "context_missing"
  // 단독 감사·확인 인사 — LLM/캐시 없이 결정론 응답 (#983 모니터에서 별도 라벨).
  | "ack"
  // 범위 되묻기(`야구 룰`·`뭐 물어볼 수 있어`)에 범위 안내로 답한 경로.
  //
  // ⚠️ 왜 `ack` 에 섞지 않고 별도 라벨인가 (삼순 2026-08-08 조건 ④).
  //   처음엔 migration 을 아끼려고 `ack` 으로 기록했는데, 그러면 **이 PR 이 고친 것을
  //   측정할 수가 없다.** 감사 질문은 "범위 안내가 얼마나 나갔고, 그중 과차단은 몇 건인가"
  //   인데 `ack`(감사 인사)와 한 칸에 들어가면 분모부터 만들 수 없다.
  //   `question` 으로 구분하면 된다고 적었지만, 판정이 폐쇄집합이 아니라 **구조 판정**이라
  //   질문 문자열을 열거할 수 없다 — 그 주석 자체가 틀렸다.
  //   `team_rag`·`news_rag` 를 `rag` 에서 분리한 것과 같은 이유다: 감사 축이 다르면 라벨을 나눈다.
  | "scope_guide"
  // 로스터에 없는 실명을 받아 **생성 없이** 이름을 되물은 경로.
  //
  // ⚠️ 왜 `blocked`·`unsure` 에 섮지 않는가 — 세 문구가 유저에게 말하는 사실이 다르다.
  //   `blocked` = "그건 우리 주제가 아니다"  → 야구 질문을 한 유저에게 거짓말이다
  //   `unsure`  = "못 알아들었다"        → 우리는 누구를 말하는지 알면서 숨기는 것이다
  //   `name_suggest` = "혹시 임찬규?"      → 유저가 바로 다음 행동을 할 수 있다
  //   감사 축도 다르다: "오타 교정이 얼마나 나갔고 그중 오제안은 몇 건인가" 를 세려면
  //   전용 라벨이 유일한 식별자다(`scope_guide` 를 `ack` 에서 분리한 것과 같은 축).
  | "name_suggest"
  // 선수 서술형 질문을 수집된 tier2 문서 근거로 답한 경로 (S2b).
  | "rag"
  // 구단 서술형 질문을 적재된 구단 문서 근거로 답한 경로.
  //
  // ⚠️ 왜 `rag` 와 분리하는가 (삼순 2026-08-07): 선수·공식문서·구단 RAG 가 전부
  //   `match_path='rag'` 로 기록돼 **구단 답변만 뽑아낼 수가 없었다.** 그래서 출시 후
  //   전수 감사(숫자 누수·과차단 실측)를 하겠다고 약속해 놓고 정작 쿼리를 못 짰다.
  //   한글 수사 파서를 삭제한 뒤로는 감사가 **유일한 안전망**이라 식별자가 필수다.
  | "team_rag"
  // 최근 30일 구단 기사 근거로 답한 경로.
  //
  // ⚠️ `team_rag` 와 분리하는 이유는 `team_rag` 를 `rag` 에서 분리한 것과 같다 —
  //   근거의 **수명이 다르다**. 문서는 수집 시점에 고정되지만 기사는 30일이 지나면 purge 된다.
  //   같은 질문에 지난달과 오늘의 답이 다를 수 있다는 뜻이라, 오답 감사를 할 때 문서 경로와
  //   섮이면 "근거가 사라졌는지" 와 "근거가 틀렸는지" 를 구분할 수 없다.
  | "news_rag"
  // 시즌 기록(수치)을 구조화 DB 원값으로 답한 경로. LLM·RAG·cache 미사용이라
  // 생성답(llm)·근거답(rag)과 리스크가 전혀 다르다 — #983 모니터에서 분리 관측한다.
  | "kbo_structured"
  // 동명이인으로 선수를 특정하지 못해 선택지를 되물은 경로. 답변이 아니라 **되물기**라
  // blocked와 같은 칸에 넣으면 #983 모니터에서 "못 답한 질문"으로 오집계된다.
  | "player_picker"
  | "unsure"
  // `<X> <지표>` 에서 X 를 운영 데이터로 특정하지 못해 되물은 경로.
  //
  // ⚠️ `unsure` 와 화면 취급은 같지만(둘 다 못 답함) **원인 축이 다르다**:
  //   `unsure` 는 LLM 까지 갔는데 확신 못 한 것, 이것은 애초에 대상을 특정 못 한 것이다.
  //   원인도 처방도 달라 한 칸에 두면 과차단 감사의 분모를 만들 수 없다.
  | "stat_clarify"
  | "limited"
  | "error"
  // LLM winner가 다른 worker — 이 worker는 답변 발송 없이 물러난다 (로그/DB 미기록).
  | "pending";

export interface QaResult {
  status: number;
  answer: string;
  source: MatchPath;
  term?: string;
  remaining: number;
  /**
   * `source === "player_picker"` 일 때만 채워진다. 호출부(server.ts)가 DM payload 로 실어
   * 클라이언트가 선택 카드를 렌더하게 한다.
   */
  pickerOptions?: PlayerPickerOption[];
  /**
   * 근거 문서 링크. `source === "rag"` 일 때만 채워진다.
   * 본문에는 `📄 출처: 나무위키` 표시명만 있고, 호출부(server.ts)가 이 URL 을 payload 로 실어
   * 클라가 그 문구에 하이퍼링크를 씌운다 (하린아빠 2026-08-05 P0).
   */
  sourceUrl?: string;
}

export interface QaDeps {
  loadGlossary: () => Promise<GlossaryEntry[]>;
  loadPlayers: () => Promise<PlayerRef[]>;
  getCache: (questionNorm: string) => Promise<string | null>;
  setCache: (questionNorm: string, answer: string) => Promise<void>;
  callLlm: (question: string, context?: ContextTurn, rosterBlock?: string) => Promise<LlmResult>;
  /**
   * 선수 entity로 필터된 tier2 근거 검색 (S2b). 미배선이면 RAG 경로 자체가 비활성이라
   * 기존 동작 그대로다.
   */
  searchRag?: (candidate: RagEntityCandidate, question: string) => Promise<RagEvidence[]>;
  /** 근거를 **비신뢰 데이터**로만 전달하는 재서술 호출 (S2b). */
  callRagLlm?: (question: string, evidence: RagEvidence[], extras?: RagLlmExtras) => Promise<LlmResult>;
  /**
   * 구단 tier2 근거 재서술 호출. 선수 경로(`callRagLlm`)와 분리한 이유는
   * 프롬프트가 다르기 때문이다 — 선수용은 숫자를 전면 금지해서 구단 서사의
   * 창단 연도까지 거부한다. 수치 안전은 문구가 아니라 출력 가드가 강제한다.
   */
  callTeamRagLlm?: (question: string, evidence: RagEvidence[], extras?: RagLlmExtras) => Promise<LlmResult>;
  /** 현재 출시 범위는 룰/용어만이다. 선수 RAG는 후속 출시에서 명시적으로 켠다. */
  enablePlayerRag?: boolean;
  /**
   * 구단 서술형·구단 미서빙 수치를 tier2 근거로 답하는 경로. 미배선이면 종전 동작
   * (`llm_scope_gate` → generic LLM, 미서빙 수치는 `TEAM_STAT_HOLD_ANSWER`) 그대로다.
   */
  enableTeamRag?: boolean;
  /**
   * 최근 30일 구단 기사 근거 검색 (news_rag). 미배선이면 이 경로 자체가 비활성이라
   * 기존 동작(team_rag → generic LLM) 그대로다.
   *
   * ⚠️ 빈 배열과 예외를 **구분해서** 던진다. 검색 실패를 "기사 없음"으로 둔갑하면
   *   장애 중에 조용히 폴백해서 낙은 근거로 답하게 된다(삼순 ②).
   */
  searchNewsRag?: (candidate: RagNewsCandidate, question: string) => Promise<RagEvidence[]>;
  /** 기사(tier2) 근거 전용 재서술 호출. 프롬프트만 다르고 경계는 선수·구단과 동일하다. */
  callNewsRagLlm?: (question: string, evidence: RagEvidence[]) => Promise<LlmResult>;
  /**
   * KBO 공식 **당일 1군 등록 명단** 조회 (`roster_snapshots` 최신 snapshot_date).
   *
   * ⚠️ SSOT 분리 (삼순 2026-08-10): `players-roster.json` 은 **현재 소속** SSOT 일 뿐
   *   1군 등록 SSOT 가 아니다. `기아 1군 선수` 는 이 명단이 정본이다.
   *   미주입·조회 실패면 전체 등록 명단 + "1군 구분 불가" 고지로 fail-close 한다.
   */
  fetchTeamEntry?: (teamId: number) => Promise<{ snapshotDate: string; players: string[] } | null>;
  /**
   * 최근 기사 근거 경로 ON/OFF. 미지정이면 꺼진 것으로 본다 — 새 경로는 명시적으로 켜야 한다.
   */
  enableNewsRag?: boolean;
  /**
   * 유저가 동명이인 picker에서 고른 kboId (재질의). 있으면 이름 매칭을 건너뛰고
   * 이 선수로 확정한다. 로스터에 없는 id면 무시되어 기존 경로로 내려간다.
   */
  pickedPlayerKboId?: string | null;
  /**
   * picker 되물기 전용 quota 반납. 되물기는 답변이 아니므로 하루 한도를 깎지 않는다
   * (하린아빠 승인 A안: picker 무료 · 선택 후 답변에서만 1개 차감).
   * 미주입이면 반납 없이 동작한다 — 기존 호출부 계약 무변경.
   */
  releaseDaily?: (userId: string) => Promise<void>;
  /**
   * 시즌 기록 조회 (kbo_structured). **kboId exact** 로만 조회한다 — 이름 조회는
   * 동명이인을 섞어버리므로 금지다(삼순 조건 ①). 미주입이면 기록 경로 자체가 비활성이라
   * 기존 동작(서술형 RAG 또는 차단) 그대로다.
   */
  fetchSeasonRecord?: (
    table: "batter" | "pitcher",
    kboId: string,
  ) => Promise<SeasonRecordRow[]>;
  /**
   * 도루·출루율·장타율·OPS 조회 (`SNAPSHOT_ONLY_BATTER_METRICS`).
   *
   * `player_stats_batter` 에는 이 컬럼들이 없고, 앱 화면이 실제로 쓰는 정본은
   * `stats-2026-batters.json`(=`/api/stats` 반환값)이다. **봇이 앱과 다른 숫자를
   * 말하는 것이 가장 나쁜 결과**이므로 화면과 같은 소스를 본다.
   * 미주입이면 해당 지표 경로가 비활성이라 기존 동작 그대로다.
   */
  fetchServedRecord?: (kboId: string) => Promise<SeasonRecordRow[]>;
  /**
   * 구단 기록 조회 (kbo_structured — 팀 축).
   *
   * ⚠️ 종전에는 이 경로가 아예 없어서 `LG 지금 몇 위야?`가 고정 안내문으로 닫혔다.
   * 근거는 "팀 집계 정본이 없다"였는데 **틀렸다** — `/api/standings`와 `/api/team-records`가
   * 이미 앱 순위탭·팀기록탭에 그 값을 서빙하고 있다(하린아빠 2026-08-04 20:42 지적).
   * 미주입이면 팀 기록 경로가 비활성이라 기존 동작 그대로다.
   */
  fetchTeamRecord?: TeamRecordFetchers;
  /** 기록 stale 판정 기준 시각 (테스트 주입). 기본값 `Date.now()`. */
  now?: () => number;
  /**
   * KBO 공식 간행물(tier1) 근거 검색 — 규칙·용어 질문용.
   *
   * 선수 경로와 달리 entity로 문서를 특정하지 않는다. 미배선이면 이 경로 자체가 비활성이라
   * 기존 동작(사전 → 캐시 → 일반 LLM) 그대로다.
   */
  searchOfficialRag?: (question: string) => Promise<RagEvidence[]>;
  /** 공식 간행물 근거 전용 재서술 호출. tier1이므로 근거에 적힌 숫자를 쓸 수 있다. */
  callOfficialRagLlm?: (question: string, evidence: RagEvidence[]) => Promise<LlmResult>;
  /** 수요 기반 ingestion 우선순위용 — 질문이 지목한 source를 기록한다. 실패는 무시한다. */
  recordRagDemand?: (sourceKeys: string[]) => Promise<void>;
  /**
   * 현재 질문 바로 직전의 user turn 1행 (spec §4.1 B1·B2). 후속 문법일 때만 조회한다.
   * 과거 폴백은 없다 — 이 1행이 부적격이면 맥락 없음으로 종료한다.
   */
  loadPreviousTurn?: () => Promise<PreviousTurnRow | null>;
  reserveDaily: (userId: string, limit: number) => Promise<{ allowed: boolean; remaining: number }>;
  /**
   * messageId의 durable LLM 상태: 호출 시작 여부 + 저장된 결과 (job 행 기준).
   * ownerActive는 started·결과 없음일 때 winner의 callLlm이 아직 진행 중일 수 있는
   * fence 창인지(=이 worker는 물러나야 하는지)를 뜻한다 (삼순 5차 P1).
   */
  getLlmState?: () => Promise<{ started: boolean; result: LlmResult | null; ownerActive?: boolean }>;
  /**
   * LLM 시작권 atomic CAS — 단일 UPDATE ... WHERE llm_started=false로 정확히 한 worker만
   * true(winner)를 받아 callLlm을 실행한다. false(loser)는 발송 없이 물러난다 (삼순 5차 P1).
   */
  acquireLlmStart?: () => Promise<boolean>;
  /** LLM 호출 직후 결과를 durable 저장 — 이후 단계 crash 시 재시도가 LLM을 재소비하지 않게 한다. */
  storeLlm?: (result: LlmResult) => Promise<void>;
  log: (entry: {
    userId: string;
    question: string;
    questionNorm: string;
    matchPath: MatchPath;
    answer: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }) => Promise<void>;
}

const SERVICE_WORDS = [
  "크보팬", "앱", "로그인", "회원가입", "탈퇴", "버그", "오류", "에러", "건의",
  "피드백", "알림", "쪽지", "업데이트", "결제", "계정",
];
const HISTORY_CONTEXT_WORDS = [
  "통산", "성적", "우승", "연도", "시즌", "드래프트", "은퇴", "몇승", "몇 홈런",
  "지난해", "작년", "올해",
];
const STAT_WORDS = [
  "타율", "방어율", "평균자책", "출루율", "장타율", "ops", "war", "wrc",
  "홈런", "안타", "타점", "도루", "승", "승수", "패", "세이브", "홀드", "삼진", "기록", "스탯",
];
/**
 * KBO 10개 구단의 **canonical 식별자 ↔ 허용 alias** 쌍.
 *
 * 약칭(`lg`)과 별칭(`트윈스`)을 팀별로 묶어 둔다. 붙여 쓴 풀네임(`LG트윈스`)을
 * 여기에 직접 열거하지 않는 이유는 가지수(띄어쓰기·영문·한글 조합)가 계속 늘고
 * 빠진 조합이 조용히 뚫리기 때문이다 — 조합은 `mentionsTeam()` 이 계산한다.
 *
 * ⚠️ 팀별로 묶는 것이 핵심이다(삼순 1차 P0-2). 약칭·별칭을 평평한 두 배열로 두면
 * `LG라이온즈`·`KIA베어스`·`두산트윈스` 같은 **존재하지 않는 구단**을 정본으로
 * 인정하게 된다. 그런 오표기는 구단 지명이 아니므로 LLM 2차 가드로 내려보낸다.
 *
 * ⚠️ `kia` 누락으로 `KIA의 역사` 가 구단 질문으로 안 잡혔다(2026-08-04 실측).
 * 로스터 정본의 team 값은 `KIA|KT|LG|NC|SSG|두산|롯데|삼성|키움|한화` 다.
 */
const TEAM_ALIASES: ReadonlyArray<{
  readonly canonical: string;
  /** `TEAMS` 의 teamId — `/api/standings`·`/api/team-records` 조인 키. */
  readonly teamId: number;
  readonly shorts: readonly string[];
  readonly nicks: readonly string[];
}> = [
  { canonical: "LG", teamId: 1, shorts: ["lg", "엘지"], nicks: ["트윈스"] },
  { canonical: "KIA", teamId: 6, shorts: ["kia", "기아"], nicks: ["타이거즈"] },
  { canonical: "두산", teamId: 2, shorts: ["두산"], nicks: ["베어스"] },
  { canonical: "롯데", teamId: 7, shorts: ["롯데"], nicks: ["자이언츠"] },
  { canonical: "삼성", teamId: 8, shorts: ["삼성"], nicks: ["라이온즈"] },
  { canonical: "한화", teamId: 9, shorts: ["한화"], nicks: ["이글스"] },
  { canonical: "키움", teamId: 10, shorts: ["키움"], nicks: ["히어로즈"] },
  { canonical: "KT", teamId: 3, shorts: ["kt"], nicks: ["위즈"] },
  { canonical: "SSG", teamId: 4, shorts: ["ssg"], nicks: ["랜더스"] },
  { canonical: "NC", teamId: 5, shorts: ["nc"], nicks: ["다이노스"] },
];
const TEAM_WORDS = TEAM_ALIASES.flatMap(({ shorts, nicks }) => [...shorts, ...nicks]);

/**
 * `<X> <지표>` 에서 `<X>` 자리에 오지만 **자기 자신이 엔티티가 아니고 앞서 지명된
 * 구단을 가리키는** 대용어.
 *
 * 왜 폐쇄집합인가 — 구단 수치 지표를 가리키는 한국어 대용어는 문법적으로 닫힌 부류다
 * (`팀`·`구단`). 존대·완곡 어미처럼 무한 조합이 아니므로 열거가 정당하다.
 * (동일 논거 — `HEAD_NON_ENTITY_UNITS` 의 인칭 대명사 축)
 */
const TEAM_ANAPHOR_HEADS: readonly string[] = ["팀", "구단"];

/**
 * 구단 지명 여부. 단일 토큰 매칭에 **같은 팀의** 약칭+별칭 결합형을 더한다.
 *
 * ⚠️ 왜 필요한가 (2026-08-04 유저 제보 → 실측):
 * 토큰화는 `LG트윈스의` 를 한 덩어리로 만들어 `lg` 와도 `트윈스` 와도 일치하지
 * 않는다. 그래서 `LG 트윈스의 역사`(띄어쓰기)와 `LG트윈스의 역사`(붙여쓰기)가
 * **서로 다른 답을 받았다**. 10개 구단 전부 동일.
 *
 * 조합 규칙은 두 층으로 좀게 둔다.
 *  ① 약칭과 별칭이 **같은 팀**이어야 한다 — `LG라이온즈`는 구단이 아니다.
 *  ② 남는 꺼리는 기존 문법 꺼리 폐쇄집합(`isGrammaticalTail`)으로만 분해되어야 한다 —
 *    `두산베어스의` → 허용, `두산베어스키핑` 같은 어휘 밖 잔여물은 닫힌다.
 * 둘 다 모두 "구단이 아니다"로 떨어지며, 그러면 차단이 아니라 LLM 2차 가드로 간다.
 */
/**
 * 게이트 전용 래퍼 — 질문 문자열을 받아 구단 지명 여부를 돌려준다.
 *
 * `mentionsTeam()` 은 토큰 배열을 받으므로 게이트가 토큰화를 **직접 재현**해야 하는데,
 * 그러면 게이트가 검증 대상의 전처리를 자기 손으로 다시 짜는 셈이라 토큰화가 바뀌어도
 * 게이트는 조용히 GREEN 이 된다. 배포 경로와 같은 정규화·토큰화를 타도록 여기서 감싼다.
 */
export function mentionsTeamForGate(question: string): boolean {
  return mentionsTeam(questionTokens(question.normalize("NFKC").toLowerCase()));
}

/**
 * 질문이 지명한 구단의 **canonical 이름**을 돌려준다. 없으면 null.
 *
 * `mentionsTeam` 과 같은 판정 규칙을 쓴다 — 둘이 갈라지면 "구단이라고 판정했는데
 * 어느 구단인지 모른다"는 모순이 생긴다. 두 구단 이상이 지명되면 null —
 * `LG랑 두산 중 누가 높아?` 처럼 비교 질문을 한 팀 기록으로 답하면 동문서답이다.
 */
export function teamIdOfCanonical(canonical: string): number | null {
  const entry = TEAM_ALIASES.find((team) => team.canonical === canonical);
  return entry ? entry.teamId : null;
}

/**
 * 구단 RAG 근거 검색 대상을 해석한다. 질문이 구단 하나를 특정해야 한다.
 *
 * `resolveMentionedTeam` 과 **같은 판정기**를 쓴다 — 둘이 갈라지면 "구단이라고 판정했는데
 * 근거는 다른 구단에서 찾는" 사고가 난다. 두 구단 이상은 `resolveMentionedTeam` 이 이미
 * null 을 돌려준다(비교 질문을 한 구단 문서로 답하면 동문서답이다).
 *
 * `entityId` 는 corpus 적재 귀속과 동일한 **teamId** 문자열이다(`namu:team:<teamId>`).
 * 매니페스트(`namu-core-manifest.json`)와 `TEAM_ALIASES.teamId` 가 같은 번호를 쓰므로
 * 여기서 별도 매핑표를 두지 않는다 — 둘을 이어주는 계약은 게이트가 실 corpus 로 고정한다.
 */
export function resolveRagTeamCandidate(question: string): RagTeamCandidate | null {
  const canonical = resolveMentionedTeam(question);
  if (canonical === null) return null;
  const teamId = teamIdOfCanonical(canonical);
  if (teamId === null) return null;

  // ⚠️ 토큰 매칭은 허용 조사 목록 밖의 결합형(`LG랑`)을 놓친다. 그래서
  // `LG랑 두산 중 누가 더 잘해?` 는 두산 **하나만** 지명된 것처럼 보인다.
  // 팀기록 조회는 숫자 하나라 피해가 작지만, RAG 는 **한 구단 문서로 서술을 생성**하므로
  // 비교 질문에 한쪽 문서만 읽으면 동문서답을 근거까지 달고 내보낸다.
  // 선수 경로(`buildCandidate` 의 `mentionsOther`)와 같은 보수 규칙을 쓴다 —
  // 조사와 무관하게 다른 구단의 약칭·별칭이 문자열로 등장하면 단일 entity 로 보지 않는다.
  // 과탐지는 RAG 미서빙(기존 경로 유지)일 뿐이고, 놓치면 남의 문서로 답하는 사고다.
  const normalized = question.normalize("NFKC").toLowerCase();
  const mentionsOtherTeam = TEAM_ALIASES.some((team) =>
    team.canonical !== canonical &&
    [...team.shorts, ...team.nicks].some((word) => normalized.includes(word)));
  if (mentionsOtherTeam) return null;

  return {
    entityType: "team",
    entityId: String(teamId),
    name: canonical,
    sourceKey: `namu:team:${teamId}`,
  };
}

export function resolveMentionedTeam(question: string): string | null {
  const tokens = questionTokens(question.normalize("NFKC").toLowerCase());
  const hits = new Set<string>();
  for (const { canonical, shorts, nicks } of TEAM_ALIASES) {
    const direct = [...shorts, ...nicks].some((word) => tokenMatches(tokens, word));
    const combined = tokens.some((token) =>
      shorts.some((short) => {
        if (!token.startsWith(short)) return false;
        const rest = token.slice(short.length);
        return nicks.some((nick) =>
          rest.startsWith(nick) && isGrammaticalTail(rest.slice(nick.length)));
      }));
    if (direct || combined) hits.add(canonical);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

function mentionsTeam(tokens: string[]): boolean {
  if (TEAM_WORDS.some((word) => tokenMatches(tokens, word))) return true;
  return tokens.some((token) =>
    TEAM_ALIASES.some(({ shorts, nicks }) =>
      shorts.some((short) => {
        if (!token.startsWith(short)) return false;
        const rest = token.slice(short.length);
        // 같은 팀의 별칭만 인정한다 — 교차조합(`LG라이온즈`)은 구단이 아니다.
        return nicks.some((nick) =>
          rest.startsWith(nick) && isGrammaticalTail(rest.slice(nick.length)));
      })));
}
const BASEBALL_WORDS = [
  "야구", "투수", "타자", "포수", "주자", "심판", "스트라이크", "아웃", "안타",
  "홈런", "이닝", "베이스", "타석", "투구", "수비", "보크", "파울", "번트",
  "도루", "병살", "태그", "세이프", "엔트리", "로스터", "피치클락", "abs", "시프트",
  "타율", "방어율", "평균자책", "기록", "스탯", "war",
];
const RULE_TERM_HINT_WORDS = [
  "잔루", "만루", "순위", "인필드플라이", "화이트볼", "너클볼", "포지션", "지명타자", "대타", "대주자",
  "1루수", "2루수", "3루수", "유격수", "외야수", "내야수",
];
const GENERIC_RULE_TERM_HINTS = new Set(["순위", "포지션"]);
const RULE_SCOPE_SIGNAL_WORDS = [
  "규칙", "룰", "용어", "판정", "보크", "견제", "태그업", "마운드", "비디오판독",
  "챌린지", "우천중단", "콜드게임", "연장전", "무승부", "순위결정", "체크스윙", "스트라이크", "아웃", "파울", "번트",
  "도루", "병살", "세이프", "피치클락", "시프트", "볼넷", "낫아웃", "희생플라이", "교체",
];
const GENERIC_RULE_SCOPE_WORDS = new Set(["규칙", "룰", "용어", "판정", "교체"]);
const RULE_ACTOR_WORDS = [
  "감독", "코치", "매니저", "주장", "선수", "투수", "타자", "포수", "주자", "심판", "수비",
  "지명타자", "대타", "대주자", "1루수", "2루수", "3루수", "유격수", "외야수", "내야수",
];
const RULE_TERM_INTENT =
  /뭐|뭔|무엇|뜻|설명|알려|규칙|룰|용어|어떻게|언제|몇\s*번|해야|할\s*수|가능|되나|돼|되죠|괜찮|차이|절차|경우|궁금|바꾸|바뀌|변경|방문|항의|처리|정해/;
const OUT_OF_SCOPE_INTENT =
  /별명|누구|누가\s*더|더\s*잘|비교|역대|최고|최악|추천|오늘\s*경기|날씨|주식|코인|요리|프롬프트|비밀번호|영화|메뉴|가방|하늘|음식|맛집|몇\s*시|시\s*(?:써|하나)|아무거나/;

/**
 * 위 denylist 중 **구단이 지명되면 범위 밖이 아닌** 패턴.
 *
 * ⚠️ `누구`·`별명`·`역대`는 맥락 없이 보면 사적인 인물 질문이지만, 구단이 붙으면
 * `LG트윈스 감독 누구야?`·`두산 별명이 뭐야?`·`삼성 역대 우승` 처럼 **구단 질문**이다.
 * 하린아빠가 확정한 답변 범위(야구룰·구단·선수·기록) 안이므로 `blocked` 로 끝내면 틀린
 * 안내다(삼순 #1100 1차 P0-1 실표본 `LG트윈스 감독 누구야?`).
 *
 * 반면 `날씨`·`주식`·`맛집`·`프롬프트` 등은 구단이 붙어도 여전히 범위 밖이다
 * (`LG 경기장 근처 맛집`). 그래서 면제는 **인물·평가·역사 축만** 좀게 열어둔다.
 */
const TEAM_BOUND_IN_SCOPE_INTENT = /별명|누구|누가\s*더|더\s*잘|비교|역대|최고|최악/;

/**
 * 범위 밖 의도 판정. 구단이 지명되면 인물·평가·역사 축은 면제한다.
 */
function isOutOfScopeIntent(normalized: string, hasTeam: boolean): boolean {
  if (!OUT_OF_SCOPE_INTENT.test(normalized)) return false;
  if (!hasTeam) return true;
  // 구단 질문이면 면제 패턴을 지우고 남는 것이 있는지로 다시 본다 —
  // `LG 경기장 맛집 추천` 처럼 면제부와 범위밖이 섞여 있으면 여전히 범위 밖이다.
  return OUT_OF_SCOPE_INTENT.test(normalized.replace(new RegExp(TEAM_BOUND_IN_SCOPE_INTENT, "g"), ""));
}
/**
 * `<X> <지표>` 모양 문장의 **3분기 판정** (삼순 2026-08-08).
 *
 * ── 왜 정규식 하나로 두면 안 되는가 (인입 3,162건 전수 감사) ──────────────────────
 *
 * 종전 구현은 `[가-힣]{2,12} <지표>` 를 통째로 "선수 기록 요구"로 보고 `blocked` 로
 * 끝냈다. 이름 자리에 한국어 아무 단어나 걸리므로 명백한 룰·용어 질문이 함께 죽었다 —
 * 라우팅 즉시차단 108건 중 **72건(67%)**이 이 한 줄 때문이었다.
 *
 *     루킹 삼진이 뭐야         X=`루킹`
 *     만루 홈런이 뭐야?        X=`만루`    ← 사전에 `만루홈런` 이 있는데도 차단
 *     홀드와 세이브의 차이가 뭐야?  X=`홀드와`
 *     끝내기 안타              X=`끝내기`  ← 사전 항목
 *
 * ── 폐기한 두 방향 ────────────────────────────────────────────────────────────
 *
 * ① **접미 필수화**(`몇`·`얼마` 를 필수로) — 72건이 풀리지만 `이대호 홈런`·`홍길동 홈런`
 *    처럼 **접미 없는 수치 질문**이 통째로 열린다. 운영 DB 에 없는 인물이라 generic LLM 이
 *    숫자를 지어낸다. 과차단은 안내로 끝나지만 누수는 없는 기록을 사실처럼 말하는 것이다.
 * ② **한글 이름 모양 휴리스틱**(성씨 닫힌집합 + 2~4자) — `이대호`는 막지만 판정 근거가
 *    "한국인 이름처럼 생겼다"는 추정이다. 반대가설을 만들 수 있는 축은 코드로 두지 않는다
 *    (2026-08-07 확정 원칙). `장내`·`고척돔`이 성씨로 시작한다는 이유로 이름 취급된 것도
 *    같은 결함의 발현이다.
 *
 * ── 채택: 추정하지 않고 **검증 가능한 것만** 본다 ──────────────────────────────
 *
 *   ① `entity_stat`  X 가 **DB 결속 엔티티**(로스터 등재 선수·구단)이고 수치 의도가 있다
 *                    → 기존 기록 경로. 존재가 데이터로 확인되므로 추정이 아니다.
 *   ② `term_question` X 가 **검증된 용어 근거**(검수 사전)이거나 문장에 **정의 의도**가 있다
 *                    → 이 가드로 닫지 않는다. 용어 질문이다.
 *   ③ `ambiguous`    둘 다 아닌 bare 모호형 → **되묻기**.
 *
 * ③이 핵심이다. `이대호 홈런`은 DB 에도 없고 용어도 아니라 **되묻기로 종결**된다 —
 * LLM 으로 내려가지 않으므로 환각이 애초에 불가능하다. 종전의 `blocked`("야구 이야기만
 * 답해드릴 수 있어요")보다 정확한 안내이기도 하다. 유저는 야구를 물었기 때문이다.
 *
 * ⚠️ 되묻기 라벨은 기존 `unsure` 를 쓴다. 이미 `MatchPath` 허용값이라 CHECK migration 이
 *    필요 없고, 의미도 같다("무엇을 물었는지 특정 못 함").
 */
const NAMED_STAT_HEAD =
  /([가-힣a-z0-9]{1,12})(?:의|은|는|이|가)?\s+(타율|방어율|평균자책|출루율|장타율|홈런|안타|타점|도루|승수|세이브|홀드|삼진|기록|스탯)\s*(?:몇|얼마|알려|보여|기록)?/g;

/**
 * **정의를 묻는 의도**.
 *
 * ⚠️ 이것만으로는 **용어로 승격하지 않는다**(삼순 2026-08-08 P0). 종전에는 정의 의도가
 *   있으면 열었는데, `오타니 홈런이 뭐야`·`홍길동 타점 설명` 이 그대로 LLM/RAG 로 샜다.
 *   `루킹 삼진이 뭐야` 와 구조가 **완전히 같아서**(둘 다 미결속 head + 지표 + 정의 의도)
 *   의도만으로는 두 경우를 가를 수 없다. 가를 수 없으면 되묻는다.
 *
 *   지금 이 상수는 **되묻기 문구를 고르는 데만** 쓴다(용어 쪽으로 물어봤는지).
 */
const TERM_DEFINITION_INTENT =
  /뭐야|뭐예요|뭐에요|뭔데|뭔지|뭐라|무슨|무엇|뜻|의미|차이|설명|가르쳐|모야|머야|정확히|불러|부르는|인정|어떤\s*거|다른\s*건가/;

export type NamedStatKind = "entity_stat" | "term_question" | "ambiguous" | "none";

/**
 * 매치 주변 잔여에 **새 야구 정보가 있는가**.
 *
 * ⚠️ 이것이 이 가드의 판정 축이다(삼순 2026-08-08 P0, 세 번째 재설계).
 *
 * 같은 실패를 세 번 했다:
 *   ① `m.index !== 0`(위치)         → `그럼 이대호 홈런` 이 빠져나갔다
 *   ② `REQUEST_TAILS`(꼬리 열거)     → `알려줘요`·`부탁해` 가 빠져나갔다
 *   ③ `FUNCTION_UNITS`(기능어 열거)  → `알려주실래요`·`부탁드립니다` 가 빠져나갔다
 * ③은 ②를 더 큰 열거로 바꾼 것일 뿐이었다. **한국어 존대·완곡 표현은 열거로 닫히지
 * 않는다** — 어미 조합이 사실상 무한하고, 빠진 조합은 조용히 뚫린다.
 *
 * 그래서 축을 뒤집는다. "잔여가 기능어인가"(무한집합을 내가 관리)를 묻지 않고
 * **"잔여에 새 야구 정보가 있는가"**(이미 있는 SSOT 가 답한다)를 묻는다:
 *   · 야구 어휘집(`BASEBALL_VOCABULARY`) — 룰·용어·포지션·행위자
 *   · 로스터(`players`)                 — 현역 선수명
 *   · 지표어(`STAT_WORDS`)              — 또 다른 `<지표>`
 * 하나도 없으면 그 잔여는 문장의 의미를 바꾸지 않는다 → 문장은 `<X> <지표>` 그 자체다.
 *
 * `알려주실래요`·`부탁드립니다`·`좀 알려주시면 감사하겠습니다` 는 야구 정보가 0이라
 * **내가 아무것도 등록하지 않아도** bare 로 잡힌다. 반대로 `선수 역할이 바뀌면 기록은` 의
 * `선수 역할이` 는 `선수`(행위자 어휘)를 담아 정상 룰 질문으로 보호된다.
 *
 * ⚠️ 토큰 경계로 본다. 부분문자열로 보면 `아웃도어`·`도루묵` 이 야구 정보로 오인된다
 *   (기존 `GRAMMATICAL_TAIL_UNITS` 주석이 경고한 축과 같다).
 */
function carriesBaseballInformation(residue: string, players: PlayerRef[]): boolean {
  const text = residue.replace(/[?!.,~…]/gu, " ").trim();
  if (text.length === 0) return false;
  for (const rawToken of text.split(/\s+/u)) {
    if (!rawToken) continue;
    for (const core of stripTokenSuffix(rawToken)) {
      if (!core) continue;
      for (const word of BASEBALL_VOCABULARY) {
        if (core === word) return true;
        if (core.startsWith(word) && isGrammaticalTail(core.slice(word.length))) return true;
      }
      for (const stat of STAT_WORDS) {
        if (core === stat) return true;
        if (core.startsWith(stat) && isGrammaticalTail(core.slice(stat.length))) return true;
      }
      for (const player of players) {
        if (core === player.name) return true;
        const parts = player.name.split(/\s+/u);
        if (parts.length > 1 && core === parts[parts.length - 1]) return true;
      }
    }
  }
  return false;
}

/**
 * 잔여 한 조각의 **구조 판정** — 이 문장이 `<X> <지표>` 그 자체인지를 가른다.
 *
 * ⚠️ **음성 추론 폐기** (삼순 2026-08-08 P0, 네 번째 재설계).
 *
 *   직전 버전은 "잔여에 야구 SSOT 신호가 없으면 bare" 라는 음성 추론이었다.
 *   그래서 승인된 반대쌍이 전부 되묻기로 죽었다:
 *     `친구가 이대호 홈런 영상을 보내줬어`  — 서사문이지 기록 질문이 아니다
 *     `유튜브에서 이대호 홈런 봤어`        — 맥락 서사
 *     `이대호 홈런 영상 보여줘`           — 요청 대상이 지표가 아니라 영상이다
 *   `영상`·`친구` 는 야구 정보가 0 이라 bare 로 오판됐다 — "야구 신호 없음" 이
 *   "새 정보 없음" 을 함의하지 않는다는 게 음성 추론의 구멍이다.
 *
 *   그래서 bare 는 이제 **양성 증거로만** 성립한다. 잔여의 모든 토큰이 아래
 *   **닫힌 부류**(문법적으로 유한한 집합 — 어미 열거와 다르다)로 설명될 때만 bare 다:
 *     · 기능어·지시어·조사 (`HEAD_NON_ENTITY_UNITS` 분해)
 *     · 요청 어간 (`RESIDUE_REQUEST_STEMS` — 어간은 소수의 닫힌 집합이고,
 *       **접두 매칭**이라 존대·완곱 어미가 무한히 붙어도 전부 덮는다.
 *       ③에서 폐기한 건 *어미* 열거였다 — `알려줘/알려주실래요/알려주시면` 은
 *       어미로는 셈 수 없지만 어간 `알려` 하나로 닫힌다)
 *     · 수치 요구 명사·감탄 표기 (`RESIDUE_BARE_TOKENS`)
 *   그 외 토큰은 전부 **새 정보**다 → 문장은 `<X> <지표>` 가 아니므로 이 가드의
 *   범위 밖(`none`)이다. 특히 두 부류는 그 자체로 서사 증거다:
 *     · 과거 시제(받침 ㅅㅅ 음절 — 봤/줬/났/션/했…)  → 기록 *요청*은 과거형이 없다
 *     · 처소 표지 `에서` 로 끝나는 명사(회사에서·유튜브에서)  → 맥락 서사
 *   둘 다 한국어 형태론의 닫힌 부류라 열거가 아니라 구조 판정이다.
 *
 *   방향이 안전한 이유: 알 수 없는 토큰 → `none` 은 되묻기를 안 할 뿐이고,
 *   그 문장은 기존 파이프라인(사전→범위게이트→…)이 이어받는다. 생성 경로의
 *   수치 환각은 별도 P0(삼순·삼식 2026-08-08 합의)가 닫는다.
 */
type ResidueSignal = "bare" | "baseball" | "new_information";

/** 요청 어간 — 접두 매칭. 어미가 아니라 어간이므로 닫힌 소집합이다. */
const RESIDUE_REQUEST_STEMS: readonly string[] = [
  "알려", "가르쳐", "갈쳐", "갈켜", "말해", "말씀", "설명", "얘기해", "이야기해",
  "보여", "부탁", "궁금", "요청", "감사", "좀", "제발", "빨리", "빨로", "얼른",
  // 보조 요청 어간. `NAMED_STAT_HEAD` 가 꼬리의 `알려/보여` 를 매치에 **삼키므로**
  // 잔여는 `주실래요`·`주세요`·`줘` 로 시작한다(2026-08-09 즉석 검증 실측).
  // 과거형(`줬…`)은 이 검사 앞의 ㅅㅅ 받침 판정이 먼저 잡으므로 서사와 안 섞인다.
  "주", "줘", "줄", "달라", "다오",
  // 평가 의문 어간 — `이승엽 홈런 어때` 는 지표의 값/평을 묻는 bare 요청이다
  // (Vercel 빌드 스모크가 잡은 회귀, 2026-08-09). 의문 서술 어간도 닫힌 부류다.
  "어때", "어떠", "어떻", "어떤가", "어떠한", "어떻게", "어떘", "어땐",
];

/**
 * 수치 요구 명사·담화 감탄사 — 문장에 새 정보를 더하지 않는 닫힌 부류.
 * 감탄사(`아 그럼 홍길동 타점`)는 담화 표지다 — 빌드 스모크가 잡은 회귀(2026-08-09).
 */
const RESIDUE_BARE_TOKENS: readonly string[] = [
  "개수", "갟수", "수치", "숫자", "통계",
  "아", "어", "오", "음", "흠", "헐", "와", "캐", "엥", "앗", "아하", "오호", "자", "그케",
];

/** 감탄·웃음 표기(ㅋㅋ·ㅎㅎ·ㅠㅠ 등 자음/모음 단독 반복) — 정보 0. */
const EMOTICON_TOKEN = /^[ㄱ-ㅎㅏ-ㅣ]+$/u;

/**
 * 과거 시제 음절(받침 ㅅㅅ) 포함 여부 — 한국어 과거형의 형태론적 불변량이다.
 *
 * ⚠️ ㅅㅅ 받침이지만 과거가 **아닌** 음절 둘은 제외한다(2026-08-09 즉석 검증 실측):
 *   `겠`  의지·추측 — `감사하겠습니다` 가 서사로 오판돼 정중 요청이 되묻기에서 샐다.
 *   `있`  존재·현재 — `기록 있어?` 는 현재 질문이다.
 */
function hasPastTenseSyllable(token: string): boolean {
  for (const ch of token) {
    if (ch === "겠" || ch === "있") continue;
    const code = ch.codePointAt(0)!;
    if (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 20) return true;
  }
  return false;
}

function residueSignal(residue: string, players: PlayerRef[]): ResidueSignal {
  if (carriesBaseballInformation(residue, players)) return "baseball";
  const text = residue.replace(/[?!.,~…;"'“”‘’()\[\]]/gu, " ").trim();
  if (text.length === 0) return "bare";
  for (const token of text.split(/\s+/u)) {
    if (!token) continue;
    if (EMOTICON_TOKEN.test(token)) continue;
    // 서사 증거 — 과거형·처소 표지는 요청 어간보다 먼저 본다(`보내줬어` 는
    // `보여` 와 무관하지만 `보` 로 시작하는 유사 어간이 생길 때 오판을 막는다).
    if (hasPastTenseSyllable(token)) return "new_information";
    if (/에서는?$|에선$/u.test(token)) return "new_information";
    if (RESIDUE_BARE_TOKENS.includes(stripNameParticle(token))) continue;
    if (RESIDUE_REQUEST_STEMS.some((stem) => token.startsWith(stem))) continue;
    if (decomposesToUnits(token, HEAD_NON_ENTITY_LONGEST_FIRST)) continue;
    return "new_information";
  }
  return "bare";
}

/**
 * `<X>` 자리에 올 수 있지만 **엔티티일 수 없는** 지시어·의문사·연결 표지.
 *
 * ⚠️ 이건 위 SSOT 역판정으로 대체할 수 없다. 지시어·의문사는 야구 정보가 0 이면서
 *   동시에 **엔티티도 아니다** — `<X>` 자리가 비었다는 뜻이므로 판단 대상 자체가 없다.
 *   좁은 폐쇄집합으로 두는 이유: 넓히면 `주자` 가 `주`+`자` 로 쪼개져 실제 야구 어휘가
 *   사라진다(2026-08-08 게이트 실측).
 */
const HEAD_NON_ENTITY_UNITS: readonly string[] = [
  // 인칭 대명사 — 사슬 경계 도입 후 드러난 축(2026-08-08 게이트 실측).
  //   `기록에 삼진은 우리가 삼진 당한 거야?` 에서 두 번째 매치 head 가 `우리가` 인데,
  //   사이 구간(`은 `)에 야구 정보가 없어 bare 로 잡혀 정상 룰 질문이 되묻기로 끝났다.
  // ⚠️ 여기는 열거가 정당하다. 인칭 대명사는 **문법적으로 닫힌 부류**이고 head 자리는
  //   토큰 하나다 — ③에서 폐기한 존대·완곡 어미(사실상 무한 조합)와 다른 축이다.
  "우리들", "우리", "저희", "당신", "그들", "그분", "이분", "너", "내", "제", "니", "네",
  "그것", "이것", "저것", "그거", "이거", "저거", "그", "저", "이",
  "그러면", "그래서", "그리고", "그런데", "그럼", "근데", "혹시", "일단",
  "무엇", "무슨", "어떤", "어느", "언제", "어디", "누구", "얼마", "뭔지", "뭔가", "뭔데",
  "뭐라고", "뭐라", "뭐야", "뭐지", "뭐", "뭔", "왜", "몇",
  "이랑", "하고", "이고", "이며", "예요", "에요", "인가", "인지",
  "고", "랑", "며", "은", "는", "이", "가", "을", "를", "도", "만", "과", "와",
  "의", "에", "요", "야", "나",
];

/**
 * **긴 단위 우선** 정렬. 순서가 계약이다 — 짧은 단위가 먼저 걸리면 긴 단위를 삼킨다
 * (`어때` 가 `어`+`때` 로 쪼개져 분해 실패로 판정된 실측이 있다).
 */
const HEAD_NON_ENTITY_LONGEST_FIRST: readonly string[] =
  [...HEAD_NON_ENTITY_UNITS].sort((a, b) => b.length - a.length);

/** 주어진 단위 집합으로 완전히 분해되는가 — 하나라도 못 떼면 내용어가 남은 것이다. */
function decomposesToUnits(text: string, units: readonly string[]): boolean {
  let rest = text.replace(/[?!.,~…\s]/gu, "");
  outer: while (rest.length > 0) {
    for (const unit of units) {
      if (rest.startsWith(unit)) { rest = rest.slice(unit.length); continue outer; }
    }
    return false;
  }
  return true;
}

/** 토큰 끝의 조사를 떼어낸 핵. `홀드와` → `홀드` */
function stripNameParticle(token: string): string {
  return token.replace(/(?:의|은|는|이|가|과|와|랑|도|만|에|에서)$/u, "");
}

/**
 * 한 매치의 판정. 집계는 호출부에서 fail-close 로 합친다.
 *
 * ⚠️ `prefix`·`suffix` 는 **인접 매치와의 사이 구간**이지 문장 처음·끝까지가 아니다
 *   (2026-08-08 게이트 실측). `만루 홈런이랑 이대호 홈런 알려줘` 에서 두 번째 매치의
 *   앞을 문장 처음부터 재면 `만루 홈런이랑` 이 통째로 들어와 "내용어가 있다"고 오판하고
 *   혼합형이 통째로 빠져나갔다. 문장은 `<X> <지표>` 조각들이 기능어로 이어진 사슬이다.
 */
function classifyOneNamedStat(
  normalized: string,
  m: RegExpExecArray,
  prefix: string,
  suffix: string,
  glossary: GlossaryEntry[],
  players: PlayerRef[],
): NamedStatKind {
  const head = stripNameParticle(m[1]);
  const metric = m[2];
  if (!head) return "none";

  // ① DB 결속 엔티티 — 로스터 등재명(외국인 성만 쓴 경우 포함) 또는 구단
  const isRosterEntity = players.some((p) => {
    if (p.name === head) return true;
    const parts = p.name.split(/\s+/u);
    return parts.length > 1 && parts[parts.length - 1] === head;
  });
  // ⚠️ 구단 결속은 **이 매치의 head 로** 판정한다(삼순 2026-08-08 P0).
  //   문장 전체의 `hasTeam` 을 쓰면 `LG 팀타율이랑 오타니 홈런` 에서 두 매치가 **둘 다**
  //   결속으로 잡혀 미결속 절이 통과한다 — 안전한 절이 위험한 절을 태우는 형태다.
  //   `hasTeam` 은 호출부가 넘긴 문장 단위 신호라 여기서는 참고만 하지 않고 버린다.
  const isTeamEntity = mentionsTeam(questionTokens(head));
  // ⚠️ 수치 의도를 **요구하지 않는다**(2026-08-08 실측). `김도영 홈런` 처럼 bare 로 와도
  //   `<로스터 선수> <지표>` 는 기록 질문이다.
  if (isRosterEntity || isTeamEntity) return "entity_stat";

  // ①-b **`팀` 은 엔티티가 아니라 앞서 지명된 구단을 가리키는 대용어다** (2026-08-08 회귀).
  //
  //   `KIA 팀 타율 알려줘` 에서 정규식이 잡는 head 는 `KIA` 가 아니라 `팀` 이다
  //   (지표어 바로 앞 토큰이므로). `팀` 은 로스터에도 구단 약칭·별칭에도 없어
  //   ①에서 떨어지고, 사이 구간(`kia `)도 야구 어휘로 안 잡혀 bare `ambiguous` 가 됐다.
  //   그 결과 `answerQuestion` 앞단 혼합형 fail-close 가 **구단 수치 질문을 통째로**
  //   되묻기로 삼켰다 — 우리가 실제로 서빙하는 값인데 봇만 못 답하는 형태다
  //   (게이트 `team-fullname-routing` 이 `source=stat_clarify` 로 잡은 회귀).
  //
  // ⚠️ 여기서만 **문장 단위 구단 신호**를 쓴다. 삼순 P0(문장 hasTeam 금지)의 근거는
  //   `LG 팀타율이랑 오타니 홈런` 에서 **내용어 head**(`오타니`)가 남의 구단 신호를 타고
  //   결속으로 승격되는 것이었다. `팀` 은 내용어가 아니라 지시 대상이 없는 대용어라
  //   그 구멍을 되열지 않는다 — `오타니` 는 여전히 `ambiguous` 로 남는다.
  //
  // ⚠️ 구단이 **하나로 특정될 때만** 결속으로 본다(`resolveMentionedTeam`).
  //   구단이 없으면(`팀 타율 알려줘`) 어느 팀인지 모르므로 되묻기가 정답이고,
  //   둘 이상이면(`LG랑 두산 팀 타율`) 한 팀 숫자로 답하는 게 동문서답이다.
  //   판정기는 실제 조회 경로가 쓰는 것과 같은 것을 쓴다 — 갈라지면 "결속이라 통과시켰는데
  //   조회는 대상을 못 찾는" 사고가 난다.
  if (TEAM_ANAPHOR_HEADS.includes(head)) {
    return resolveMentionedTeam(normalized) !== null ? "entity_stat" : "ambiguous";
  }

  // ② **검증된 용어 근거가 있을 때만** 용어로 연다 (삼순 P0).
  //
  //   근거는 두 가지뿐이다: 검수 사전에 있거나(`만루홈런`·`끝내기안타`), 야구 어휘집에 있거나.
  //   사전은 `만루 홈런` 을 **붙여서** 수록하므로 `head + 지표` 결합형도 함께 조회한다.
  //   정의 의도(`뭐야`)는 근거가 아니다 — `오타니 홈런이 뭐야` 도 똑같이 붙는다.
  const combined = `${head}${metric}`;
  if (matchGlossary(glossary, head) !== null) return "term_question";
  if (matchGlossary(glossary, combined) !== null) return "term_question";
  if (BASEBALL_VOCABULARY.includes(head.toLowerCase())) return "term_question";
  if (BASEBALL_VOCABULARY.includes(combined.toLowerCase())) return "term_question";

  // ②-b **head 가 지시어·의문사뿐이면 `<X>` 자체가 없다**(2026-08-08 전건 감사 실측).
  //   `그 안타 기준이 머야`·`안타는 뭐고 홈런은 뭐에요?` 는 지시어/의문사 + 지표어일 뿐인데
  //   `그`·`뭐고` 를 미결속 엔티티로 읽어 되묻기로 끝났다. 종전에 답하던 룰 질문들이
  //   여기서 막혔다 — 되묻기 전환의 유일한 회귀였다.
  //
  // ⚠️ 순서가 계약이다. 이 검사는 **근거 검사 뒤**여야 한다. 앞에 두면 실제 야구 어휘가
  //   우연히 분해돼 사라진다 — `주자` 가 `주`+`자` 로 쪼개져 `주자는 도루할 수 있어?` 가
  //   판단 범위 밖으로 빠지는 것을 게이트가 잡았다. 근거를 먼저 확인하면 그 위험이 없다.
  //
  // ⚠️ 분해 단위도 **문법 표지만** 쓴다(`HEAD_NON_ENTITY_UNITS`). 요청 동사(`주`·`해`)까지
  //   섞은 일반 집합을 쓰면 같은 함정이 되살아난다(`GRAMMATICAL_TAIL_UNITS` 주석의 `도어`).
  if (decomposesToUnits(head, HEAD_NON_ENTITY_LONGEST_FIRST)) return "none";

  // ③ 근거가 없다. 되묻기로 종결할지, 이 가드의 범위 밖으로 흘릴지 가른다.
  //
  // ⚠️ **명시적 요구**가 있으면 문장 모양과 무관하게 되묻는다. 두 가지가 대칭이다:
  //     수치 요구  `홍길동은 홈런을 몇 개 쳤어?`  → 없는 숫자를 지어낸다
  //     정의 요구  `오타니 홈런이 뭐야`          → 없는 대상의 지표를 설명하며 지어낸다
  //   종전에는 정의 요구를 **용어 승격 근거**로 썼는데, `루킹 삼진이 뭐야` 와 구조가
  //   완전히 같아서(둘 다 미결속 head + 지표 + 정의 의도) 두 경우를 가를 수 없었다.
  //   가를 수 없으면 답하지 않고 되묻는다 (삼순 2026-08-08 P0).
  if (/몇|얼마/.test(normalized)) return "ambiguous";
  if (TERM_DEFINITION_INTENT.test(normalized)) return "ambiguous";

  // bare 판정 — **양성 증거로만** 성립한다(삼순 2026-08-08 P0, 음성 추론 폐기).
  //   · 잔여에 야구 정보          → 정상 룰 질문. 가드 범위 밖(none)
  //   · 잔여에 새 정보(서사·미지 토큰) → `<X> <지표>` 가 문장의 전부가 아니다(none)
  //   · 잔여가 요청·기능 구조뿐        → bare. 되묻는다(ambiguous)
  const prefixSignal = residueSignal(prefix, players);
  const suffixSignal = residueSignal(suffix, players);
  if (prefixSignal === "bare" && suffixSignal === "bare") {
    return "ambiguous";
  }

  // 잔여가 야구 정보를 담은 정상 룰 질문(`선수 역할이 바뀌면 기록은`)이거나,
  // 야구 밖 새 정보를 담은 서사·요청 문장(`친구가 이대호 홈런 영상을 보내줬어`).
  // 둘 다 이 가드의 판단 범위가 아니므로 손대지 않는다.
  return "none";
}

/**
 * `<X> <지표>` 문장을 3분기로 판정한다.
 *
 * ⚠️ **모든 매치를 본다**(삼순 P0). 종전에는 첫 `exec()` 하나만 봐서
 *   `루킹 삼진과 이대호 홈런 몇개` 처럼 앞이 용어·뒤가 수치질문인 혼합형에서
 *   앞 매치만 읽고 용어로 열었다.
 *
 * ⚠️ 집계는 **fail-close** 다: 하나라도 되묻기면 문장 전체가 되묻기다.
 *   섞인 문장은 어느 쪽으로 답해도 나머지 절이 근거 없이 생성된다.
 */
/**
 * 문장 안의 **각 `<X> <지표>` 매치별 판정**. 집계 전 원자료다.
 *
 * 집계는 정보를 지운다 — `김도영 홈런과 이대호 홈런` 은 집계하면 `ambiguous` 하나지만,
 * 실제로는 `entity_stat` 와 `ambiguous` 가 **섞인** 문장이다. 그 구분이 필요한 곳이 있다
 * (`answerQuestion` 앞단 fail-close, 삼순 2026-08-08 P0).
 */
export function classifyNamedStatMatches(
  normalized: string,
  glossary: GlossaryEntry[],
  players: PlayerRef[],
): NamedStatKind[] {
  NAMED_STAT_HEAD.lastIndex = 0;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = NAMED_STAT_HEAD.exec(normalized)) !== null) {
    matches.push(m);
    // 빈 매치 무한루프 방어(정규식은 항상 1자 이상 소비하지만 계약으로 고정한다).
    if (m[0].length === 0) NAMED_STAT_HEAD.lastIndex += 1;
  }
  if (matches.length === 0) return [];

  return matches.map((match, i) => {
    const prevEnd = i === 0 ? 0 : matches[i - 1].index + matches[i - 1][0].length;
    const nextStart = i === matches.length - 1 ? normalized.length : matches[i + 1].index;
    return classifyOneNamedStat(
      normalized,
      match,
      normalized.slice(prevEnd, match.index),
      normalized.slice(match.index + match[0].length, nextStart),
      glossary, players,
    );
  });
}

export function classifyNamedStat(
  normalized: string,
  glossary: GlossaryEntry[],
  players: PlayerRef[],
  /**
   * ⚠️ **의도적으로 쓰지 않는다**(삼순 2026-08-08 P0). 문장 단위 구단 신호를 매치마다
   *   적용하면 `LG 팀타율이랑 오타니 홈런` 의 미결속 절이 결속으로 승격돼 통과한다.
   *   구단 결속은 각 매치의 head 로 본다(`classifyOneNamedStat`).
   *   인자는 기존 호출부 호환을 위해 남긴다.
   */
  _hasTeam?: boolean,
): NamedStatKind {
  const kinds = classifyNamedStatMatches(normalized, glossary, players);
  if (kinds.length === 0) return "none";
  if (kinds.includes("ambiguous")) return "ambiguous";
  if (kinds.includes("entity_stat")) return "entity_stat";
  if (kinds.includes("term_question")) return "term_question";
  return "none";
}

/**
 * 구단 질문 중 **팀 단위 수치**를 묻는 것만 결정론적으로 가린다 (삼순 #1100 2차 P0-2).
 *
 * 지표어(`STAT_WORDS`)가 붙은 구단 질문이면서 값을 요구하는 의도(`몇`·`얼마`·`알려` 등)가
 * 있거나, 지표어 자체가 팀 수치 전용 어휘(`팀타율`·`순위`)일 때만 해당된다.
 *
 * 왜 좁게 잡는가 — 구단 질문은 대부분 서술이고(`삼성 주장`·`LG의 역사`), 그건 답변 범위
 * 안이다. 넓게 잡으면 구단 질문을 다시 과차단하는 P0-1 회귀가 된다.
 */
const TEAM_NUMERIC_STAT_WORDS = ["팀타율", "팀방어율", "팀평균자책", "팀홈런", "순위", "승률"];
const NUMERIC_VALUE_ASK = /몇|얼마/;
/**
 * **값을 달라는 요청어**. 구체 지표어와 함께 나올 때만 수치 질문으로 본다.
 *
 * ⚠️ 지표어 단독으로 닫으면 `삼성 라이온즈 홈런 잘 치는 팀이야?` 같은 **서술·평가**
 * 구단 질문까지 fail-close 된다 — P0-1(구단 과차단) 회귀다. 게이트가 실제로 잡았다.
 */
/**
 * 구단+지표 질문 중 **수치가 아니라 서술·평가**를 묻는 신호.
 *
 * ⚠️ 방향을 뷘다(삼순 #1100 4차 P0-2). 종전에는 "요청어가 있으면 닫는다"로 두었는데
 * 요청 표현은 끝없이 늘어난다 — `말해줘`·`어떻게 돼?`·`현황`·`은?` 가 전부 새었고,
 * 그때마다 generic LLM 이 `홈런 999개, 99승 1패` 를 지어냈다. 열거형 allowlist 로는
 * 수렴하지 않는다.
 *
 * 그래서 지금은 **구단+구체지표는 기본적으로 닫고**, 서술·평가 신호가 명시돈 때만 열어준다.
 * 틀렸을 때 결과가 비대칭이기 때문이다 — 과차단은 "순위표에서 보세요" 안내지만,
 * 누수는 **없는 숫자를 사실처럼 말하는** 것이다.
 */
const TEAM_DESCRIPTIVE_ASK =
  /잘\s*(?:치|하|때리|던지|막)|못\s*(?:치|하)|어떤\s*팀|유명|이야기|역사|유래|응원|분위기|성향|스타일|강점|약점|특징|소개/;

/**
 * **구체 지표어** — 이 단어가 구단과 함께 나오면 의문사(`몇`·`얼마`) 없이도 수치 질문이다.
 *
 * ⚠️ 왜 `STAT_WORDS` 전체를 쓰지 않는가 (삼순 #1100 3차 P0-2 + 2차 회귀 실측):
 * `STAT_WORDS` 에는 `기록`·`스탯` 같은 **총칭어**가 섞여 있다. 총칭어까지 이 축에 넣으면
 * `두산 기록 중 유명한 이야기 알려줘` 같은 서술형 구단 질문이 fail-close 로 끌려가
 * P0-1(구단 과차단) 회귀가 된다 — 2차에서 실제로 그렇게 죽었다.
 *
 * 반대로 `홈런`·`팀 타율`·`승패` 는 총칭이 아니라 **값을 지목한 것**이다. `알려줘`·`보여줘`
 * 처럼 의문사가 없어도 유저가 기대하는 건 숫자이고, 팀 단위 집계 정본이 없는 이상
 * generic LLM 은 그 숫자를 지어낸다(삼순 실측: `LG 홈런 알려줘` → `source=llm` +
 * `홈런 999개, 99승 1패` 통과). 그래서 의문사 유무와 무관하게 닫는다.
 */
const TEAM_CONCRETE_STAT_WORDS = [
  "타율", "방어율", "평균자책", "출루율", "장타율", "ops", "war", "wrc", "whip",
  "홈런", "안타", "타점", "도루", "세이브", "홀드", "삼진", "볼넷", "실책",
  // 승패 계열 — 삼순 4차 실표본이 여기서 대거 샜다(`전적`·`승리 수`·`패배`·`득점`).
  "승", "승수", "승리", "패", "패수", "패배", "승패", "전적", "성적",
  "득점", "실점", "득실점",
];

/**
 * 구단 수치 질문인가 — 이제는 "닫을까"가 아니라 **"조회해서 답할까"** 의 판정이다.
 *
 * ⚠️ 판정 규칙을 `resolveTeamRecordIntent` 와 **하나로 묶는다**(SSOT).
 * 라우팅은 `tokenMatches`, 조회는 regex 로 따로 가면 `LG 지금 몇 위야?`·
 * `한화 평균자책점` 처럼 **라우팅은 안 잡히는데 조회는 되는** 질문이 generic LLM 으로
 * 새어나간다(실측 3종). 두 규칙은 갈라지면 안 된다.
 */
function isTeamNumericQuestion(normalized: string, tokens: string[], hasStat: boolean): boolean {
  // ⚠️ 경기별 스코어는 **서술 예외보다 먼저** 닫는다 (2026-08-08 삼순 2차 NO-GO 실측).
  //
  //   종전에는 `TEAM_DESCRIPTIVE_ASK` 가 먼저라 `이야기`·`소개`·`유명` 이 붙으면 여기서
  //   `false` 로 빠져나가 스코어 SSOT(`resolveTeamRecordIntent`) 에 닿지도 못했다:
  //     `어제 LG 스코어 이야기해줘`      → news 경로 (실측)
  //     `어제 LG 몇 대 몇인지 이야기해줘` → team_rag (실측)
  //
  //   서술 표현은 **어조**일 뿐 물은 대상을 바꾸지 않는다 — "스코어 이야기해줘" 는
  //   결국 "몇 대 몇이었는지 말해달라" 다. 답이 숫자로 확정되는 건 마찬가지다.
  //   반면 `삼성 홈런 잘 치는 팀이야?` 처럼 **지표어 + 서술**은 수치 질문이 아니므로
  //   서술 예외는 그대로 둔다 — 순서만 바꿔 스코어만 앞으로 빼낸다.
  if (isTeamScoreQuestion(normalized)) return true;
  // 서술·평가형은 먼저 뺀다 — `삼성 홈런 잘 치는 팀이야?` 는 숫자를 물은 게 아니다.
  if (TEAM_DESCRIPTIVE_ASK.test(normalized)) return false;
  // 조회 규칙 그대로. `unserved`(우승 횟수·상대전적)도 포함한다 — 답할 수 없는 값이지만
  // **LLM 이 지어내게 둔다는 뜻은 아니다**. 안내로 명시 종결한다.
  if (resolveTeamRecordIntent(normalized).kind !== "none") return true;
  // 전용 어휘(`팀타율`)·구체 지표어는 토큰 단위로도 한 번 더 본다 — 붙여쓴 표기 대응.
  if (TEAM_NUMERIC_STAT_WORDS.some((word) => tokenMatches(tokens, word))) return true;
  if (TEAM_CONCRETE_STAT_WORDS.some((word) => tokenMatches(tokens, word))) return true;
  // 남은 총칭어(`기록`·`스탯`)는 **값을 요구하는 의도**가 함께 있을 때만 수치 질문이다.
  // 여기까지 닫으면 `두산 기록 중 유명한 이야기 알려줘` 같은 서술형이 과차단된다.
  return hasStat && NUMERIC_VALUE_ASK.test(normalized);
}

/**
 * 구단 tier2 RAG 로 서빙해도 되는 질문인가 (서술형 축).
 *
 * `answerQuestion` 에서 이 판정을 통과한 질문만 구단 문서 근거를 읽는다.
 *
 * ⚠️ 수치 질문을 여기서 다시 막는 이유 — 방어가 이중이어야 한다.
 * 상위 라우팅(`team_record`)이 수치 구단 질문을 가로채므로 이론상 여기까지
 * 안 오지만, 라우팅 규칙이 한 줄만 바뀌어도 tier2 가 수치를 답하게 된다
 * (§12 위반). 경로 의존이 아니라 **이 함수 단독으로도** 수치가 닫히게 둔다.
 *
 * 반대로 서술 의도를 allowlist 로 요구하지는 **않는다**. 구단 서술 질문은 표현이
 * 무한해서(`LG 어때?`·`두산 어떤 팀이야`·`한화 암흑기`) 폐쇄집합을 쓰면
 * 빠진 표현이 조용히 generic LLM 으로 새는데, 그랬 때 손해는 "근거 있는데 안 읽음"이다.
 * 근거가 없으면 `answerTeamRagQuestion` 이 null 로 양보하므로 과탐지는 안전하다.
 */
export function isTeamRagServableQuestion(question: string): boolean {
  const normalized = question.normalize("NFKC").toLowerCase();
  const tokens = questionTokens(normalized);
  const hasStat = STAT_WORDS.some((word) => tokenMatches(tokens, word));
  return !isTeamNumericQuestion(normalized, tokens, hasStat);
}

/**
 * 최근 기사(news_rag) 근거로 답할 질문인가 — 진입 판정 + 검색 창 산출.
 *
 * 삼순 조건부 GO ①: **단일 TEAM + 최신성 + 서술형** 세 가지가 동시에 맞을 때만 기사로 간다.
 *  · 단일 TEAM — `resolveRagTeamCandidate` 와 **같은 판정기**를 쓴다. 두 구단 이상이면 null 이라
 *    비교 질문에 한쪽 기사만 붙는 사고가 구조적으로 불가능하다.
 *  · 최신성 — `fresh` 만 소유한다. `none`(시간 신호 없음)과 `out_of_window`(올해·이번 시즌)은
 *    기존 경로가 소유한다 — 30일치로 `올해` 를 답하면 일부만 보고 전체를 말하는 것이다.
 *  · 서술형 — `isTeamRagServableQuestion` 과 **같은 수치 판정기**를 재사용한다.
 *    `어제 LG 몇 대 몇` 은 structured 가 소유하고, 기사는 수치를 말하지 않는다.
 *    판정기를 복사하지 않는다 — 복사하면 한쪽만 고쳐졌을 때 조용히 갈라진다.
 *
 * @param nowMs 판정 기준 시각(ms). 게이트가 경계값을 주입한다.
 */
export function resolveRagNewsCandidate(question: string, nowMs: number): RagNewsCandidate | null {
  // 수치 질문은 기사가 소유하지 않는다(삼순 ①). structured 가 먼저 답한다.
  if (!isTeamRagServableQuestion(question)) return null;

  const normalized = question.normalize("NFKC").toLowerCase();
  // ⚠️ 값을 묻는 질문은 **어휘 열거 없이** 닫는다.
  //
  //   `isTeamRagServableQuestion` 은 지표어(`홈런`·`순위`)가 붙은 수치 질문만 가린다.
  //   그러서 `어제 LG 몇 대 몇이었어?` 는 그 판정을 **통과한다** — `몇` 은 있는데
  //   `STAT_WORDS` 토큰이 없어 `hasStat=false` 이기 때문이다(2026-08-08 실측).
  //   삼순 ①이 명시한 바로 그 케이스다.
  //
  //   `스코어`·`점수`·`모두 몇 개` 식으로 어휘를 늘려 막으면 #1100 에서 이미 수렴하지
  //   않음이 입증됐다(요청 표현은 끝없이 늘어난다). 대신 **구조적 사실**을 쓴다:
  //   이 경로는 숫자 출력이 전면 HOLD 라 값을 물은 질문에 제대로 답할 수 **구조적으로 없다**.
  //   들어가봐야 출력 가드가 폐기해 `unsure` 로 끝나고, 그 사이에 quota 와 LLM 호출만 태운다.
  //   그러면서 structured·기존 경로가 답할 기회까지 가로채다 — 순이익이 음수다.
  if (NUMERIC_VALUE_ASK.test(normalized)) return null;

  const recency = resolveNewsRecency(question, nowMs);
  if (recency.kind !== "fresh") return null;

  // 단일 구단 판정은 team RAG 와 같은 함수를 쓴다 — 다른 구단 언급 감지(`mentionsOtherTeam`)까지
  // 그대로 상속된다. 여기서 따로 구현하면 비교 질문 방어가 한쪽에만 남는다.
  const teamCandidate = resolveRagTeamCandidate(question);
  if (!teamCandidate) return null;
  const teamId = Number(teamCandidate.entityId);
  if (!Number.isInteger(teamId)) return null;

  return {
    entityType: "news",
    teamId,
    name: teamCandidate.name,
    since: recency.since,
    until: recency.until,
  };
}

/**
 * 최신성 질문이긴 한데 기사 보유창(30일) 밖인가.
 * `올해 LG 어때?` 처럼 news 가 소유하면 **안 되는** 질문을 게이트가 직접 보기 위해 노출한다.
 */
export function newsRecencyIntentOf(question: string, nowMs: number): NewsRecencyIntent {
  return resolveNewsRecency(question, nowMs);
}

/**
 * `history_hold` 안내문을 질문 유형별로 갈라준다.
 *
 * 구단 수치에 "2026 시즌 타율·홈런을 답해드려요"(선수 지표 안내)를 내보내면 틀린 안내다 —
 * 유저가 물은 건 팀 집계이고, 그건 순위표로 보내는 게 정확한 다음 행동이다.
 */
export function resolveHoldAnswer(question: string): string {
  const normalized = question.normalize("NFKC").toLowerCase();
  const tokens = questionTokens(normalized);
  return mentionsTeam(tokens) ? TEAM_STAT_HOLD_ANSWER : HISTORY_HOLD_ANSWER;
}

/**
 * 현재 출시 범위인 야구 룰/용어 질문의 결정론적 경계.
 *
 * 범위 밖 질문을 provider 판정에 맡기면 `BASEBALL_RULE_TERM` 오판 한 번으로 일반 LLM 답과
 * global cache가 생긴다. 따라서 선수·구단·평가/인물 질의는 먼저 닫고, 검수 사전 용어 또는
 * 야구 규칙 신호 + 질문 의도가 함께 확인된 경우만 RAG/LLM/cache 경계 안으로 보낸다.
 */
export function isSupportedRuleTermQuestion(
  question: string,
  glossary: GlossaryEntry[] = [],
  players: PlayerRef[] = [],
): boolean {
  const normalized = question.normalize("NFKC").toLowerCase();
  const compact = normalized.replace(/\s+/g, "");
  const tokens = questionTokens(normalized);
  if (
    isTopicDismissal(question) ||
    dismissesDetectedBaseballTerm(question, [...BASEBALL_WORDS, ...RULE_TERM_HINT_WORDS])
  ) return false;
  const exactGlossaryMatch = matchGlossary(glossary, question) !== null;
  const mentionsRuleHint = RULE_TERM_HINT_WORDS.some((word) => mentionsSignalWord(tokens, word));
  const mentionsSpecificRuleHint = RULE_TERM_HINT_WORDS.some((word) =>
    !GENERIC_RULE_TERM_HINTS.has(word) && mentionsSignalWord(tokens, word)
  );
  const mentionsRuleScopeSignal = RULE_SCOPE_SIGNAL_WORDS.some((word) => mentionsSignalWord(tokens, word));
  const mentionsSpecificRuleSignal = RULE_SCOPE_SIGNAL_WORDS.some((word) =>
    !GENERIC_RULE_SCOPE_WORDS.has(word) && mentionsSignalWord(tokens, word)
  );
  const mentionsRuleActor = RULE_ACTOR_WORDS.some((word) => mentionsSignalWord(tokens, word));
  const mentionsRoleRule = compact.includes("역할") && (
    mentionsRuleActor ||
    /^(?:역할이바뀌면어떻게돼(?:요)?|역할과포지션차이가?뭐야(?:요)?|역할이?(?:뭐야|뭔가요|궁금해))[?!.]*$/.test(compact)
  );
  const hasRuleIntent = RULE_TERM_INTENT.test(normalized);
  // ⚠️ `ambiguous` 도 함께 제외한다(2026-08-08 실측). `entity_stat` 만 걸렀더니
  //   `이대호 도루 알려줘` 가 여기서 `baseball_rule_term` 으로 승격돼 LLM 까지 내려갔다 —
  //   `도루` 가 야구 어휘이고 `알려` 가 룰 의도라 조건이 둘 다 성립하기 때문이다.
  //   되묻기로 끝내야 할 문장이 생성 경로로 새면 3분기를 만든 의미가 없다.
  const namedStatKind = classifyNamedStat(normalized, glossary, players, mentionsTeam(tokens));
  const isOutOfScopeRequest =
    isOutOfScopeIntent(normalized, mentionsTeam(tokens)) ||
    namedStatKind === "entity_stat" ||
    namedStatKind === "ambiguous";
  const hasBaseballContext =
    exactGlossaryMatch ||
    mentionsSpecificRuleHint ||
    mentionsSpecificRuleSignal ||
    mentionsRoleRule ||
    BASEBALL_WORDS.some((word) => mentionsSignalWord(tokens, word)) ||
    mentionsTeam(tokens) ||
    hasPlayerReference(tokens, players);

  // 검수 사전의 실제 용어가 문장에 있으면 축약형(`잔루만루는`)도 용어 질문으로 인정한다.
  // 일반 엔티티 단어가 아니라 132개 검수 용어 폐쇄집합에만 해당한다.
  if (exactGlossaryMatch && !isOutOfScopeRequest) return true;
  if (
    mentionsRuleHint &&
    hasBaseballContext &&
    !hasPlayerReference(tokens, players) &&
    !mentionsTeam(tokens) &&
    !isOutOfScopeRequest
  ) return true;

  // 출시 경계는 부정어 denylist가 아니라 **룰/용어 양성 신호**로 연다. `투수`·`야구` 같은
  // 일반 엔티티 단어만으로는 절대 열지 않으므로 연봉·티켓·가족 질문이 새 표현으로 바뀌어도
  // provider/RAG/cache 앞에서 닫힌다. 선수·구단·감독은 보크/역할/마운드 방문 같은 양성
  // 신호와 질문 의도가 함께 있을 때만 룰의 예시 주체로 허용한다.
  if (
    !isOutOfScopeRequest &&
    hasBaseballContext &&
    (mentionsRuleHint || mentionsRuleScopeSignal || mentionsRoleRule) &&
    hasRuleIntent
  ) return true;
  if (hasPlayerReference(tokens, players)) return false;
  if (mentionsTeam(tokens)) return false;
  if (OUT_OF_SCOPE_INTENT.test(normalized)) return false;
  {
    const kind = classifyNamedStat(normalized, glossary, players, mentionsTeam(tokens));
    if (kind === "entity_stat" || kind === "ambiguous") return false;
  }
  if (matchGlossary(glossary, question)) return true;
  return false;
}
/**
 * 인젝션 지시부의 "명령형·연결형"만 잡는 꼬리 (삼순 4차 P0).
 * `(무시|잊)`처럼 어간만 보면 사용자의 회상형("규칙 잊었어 다시 알려줘")까지 인젝션으로
 * 오탐한다. 어미를 명시 열거해 명령/연결형만 남기고, 뒤에 `도`가 붙는 양보형
 * ("무시해도 되나요")은 lookahead로 제외한다.
 */
const INJECTION_COMMAND_TAIL = "(?:무시\\s*(?:해주세요|해줘|해라|하라|하고|해)|잊\\s*(?:어주세요|어버려|어라|어줘|으라|고|어))(?!도)";

const INJECTION_PATTERNS = [
  // "이전/위/앞의 지시·명령·규칙·프롬프트 무시" 계열. BASEBALL_WORDS fail-closed 게이트가
  // 빠진 뒤에도 인젝션은 결정론적으로 먼저 차단되어야 하므로 지시어 집합을 맞춘다.
  new RegExp(`(이전|위|앞)\\s*의?\\s*(지시|명령|규칙|프롬프트).*${INJECTION_COMMAND_TAIL}`, "i"),
  /(시스템|개발자)\s*(프롬프트|메시지|지시)/i,
  /ignore\s+(all\s+)?previous/i,
  /\bforget\s+(all\s+)?previous\s+(instructions?|prompts?)\b/i,
  /\breveal\s+(your\s+)?(system\s+)?prompt\b/i,
  /\bact\s+as\b/i,
  /(이전|위|앞|앞에\s*나온).*(무시하고|잊고).*역할\s*(변경|바꿔|바꾸)/i,
  /(링크|url).*(줘|출력|보여)/i,
  /\bignore\b[\s\S]{0,40}\b(previous|above|prior|earlier|prompt|instructions?)\b/i,
];

/**
 * 역할 변경 "명령형" 어미. 어간(변경/교체·바꾸·바꿔·바꿈)과 어미를 분리 조합해
 * 존대형(`바꾸세요`·`변경하세요`)·`-어` 활용형(`바꾸어줘`)·`-도록 해`·요청형(`변경 부탁해`)까지
 * 같은 명령 의미를 모두 덮는다. 어미를 개별 문자열로 나열하던 이전 형태는 표기가
 * 한 글자만 달라도 그대로 LLM에 누수됐다 (삼순 5차 P0).
 */
const ROLE_CHANGE_COMMAND = [
  "(?:변경|교체)(?:해주세요|해주라|해줄래|해줘요|해줘|해라|해요|해봐|해다오|하라|하세요|하십시오|합시다|하고|하도록해|해)",
  "(?:변경|교체)부탁(?:드립니다|드려요|해줘|해요|해)",
  "바꾸(?:어주세요|어줘|어라|세요|십시오|라|도록해)",
  "바꿔(?:주세요|주라|줄래|줘요|줘|요|라|봐|다오)?",
].join("|");

/** 역할변경 어절이 명령형으로 종결됐는지 (어절 전체 일치). */
const ROLE_CHANGE_IMPERATIVE = new RegExp(`^(?:${ROLE_CHANGE_COMMAND})$`);

/**
 * 조사·띄어쓰기를 제거한 압축형에 적용하는 인젝션 패턴 (삼순 2차 P0).
 * 원문 정규화만으로는 "역할을 바꿔"(목적격 조사)·"지금까지 안내를 무시하고"처럼
 * 조사·띄어쓰기가 한 칸만 달라도 exact 패턴을 빠져나가 LLM에 누수된다.
 */
const INJECTION_COMPACT_PATTERNS = [
  // "지금까지/이전/앞에 나온 (지시·안내·내용·규칙) ... 무시하고/잊어" 시작형.
  new RegExp(
    `(지금까지|이전|앞에나온|앞의|위에나온|기존|처음)(.{0,12})?(지시|명령|규칙|프롬프트|안내|내용|설정|대화)(.{0,12})?${INJECTION_COMMAND_TAIL}`,
  ),
];

/**
 * 역할변경 인젝션 판별 — **명백한 명령형만** 결정론적으로 차단한다 (삼순 11차 + 하린아빠 결정).
 *
 * 판정 기준은 하나 — 역할변경 어절 자체가 봇에게 내리는 **명령형 종결**인가
 * (`역할을 바꿔`·`역할 변경해줘`·`너의 역할을 바꿔라`). 정상 야구 질문으로는 성립하지 않는
 * 형태이므로 확신을 갖고 차단할 수 있다.
 *
 * 연결형(`바꿔서`·`바꾸면`·`바꿔도`) 뒤에 오는 절의 기능을 어미 구조로 판정하던 이전
 * 휴리스틱은 삭제한다. 그 판정에는 확신이 없어 — 후속절이 지시인지 질문인지 어미만으로는
 * 갈리지 않아 — `투수 역할을 바꾸면 어떻게 돼요?`·`수비 역할을 바꿔도 괜찮아요?` 같은
 * **정상 야구 질문을 과차단**했다. 실 Gemini 검증(공격 12/12 `NOT_BASEBALL`→`blocked`,
 * cache write 0)으로 비야구 방어는 단일 구조화 LLM 판정이 담당함이 입증됐으므로, 애매한
 * 역할변경 문장은 차단하지 않고 LLM 판정에 위임한다. 게이트 기본값은 "애매하면 통과"다.
 */
function hasRoleChangeInjection(tokens: string[]): boolean {
  for (let index = 0; index < tokens.length; index++) {
    const roleAt = tokens[index].search(/역할|role/);
    if (roleAt < 0) continue;
    const inline = tokens[index]
      .slice(roleAt)
      .replace(/^(?:역할|role)/, "")
      .replace(/^(?:을|를|은|는|이|가|의)/, "");
    const clause = inline.length > 0 ? inline : (tokens[index + 1] ?? "");
    if (ROLE_CHANGE_IMPERATIVE.test(clause)) return true;
    // 명령이 두 어절로 띄어 쓰인 형태(`역할 변경 부탁해`)도 같은 명령형이다 — 인접 1어절만 결합해
    // 판정한다. 결합 범위를 인접으로 제한해 뒤쪽 무관한 어절이 명령형을 만들어내지 않게 한다.
    const next = tokens[inline.length > 0 ? index + 1 : index + 2];
    if (next && ROLE_CHANGE_IMPERATIVE.test(`${clause}${next}`)) return true;
  }
  return false;
}

/**
 * 인젝션 판정 전용 정규화: 토큰별 "명사 조사"만 제거하고 공백을 없앤 압축 문자열.
 * `도`·`만`은 명사 조사이면서 동시에 용언 어미(`-해도`, `-지만`)라 무차별 제거하면
 * `바꿔도`→`바꿔`처럼 조건형이 명령형으로 변조돼 정상 룰 질문을 과차단한다 (삼순 4차 P0).
 */
function injectionNormalize(value: string): string {
  return questionTokens(value)
    .map((token) => (token.length >= 3 ? token.replace(/(을|를|은|는|이|가|의)$/, "") : token))
    .join("");
}

const TOKEN_TRIM_SUFFIXES = [
  "이라는", "이란", "란", "은", "는", "이", "가", "을", "를", "에", "의", "도", "만",
  "과", "와", "으로", "로", "에서", "에게", "한테", "부터", "까지", "처럼", "보다",
  "인데", "인가", "예요", "이에요", "뭐야", "뜻",
];

function questionTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[가-힣a-z0-9+]+/g) ?? [];
}

/** 한 토큰이 그 단어인가(허용 조사 꼬리포함). `tokenMatches` 의 단일 토큰 버전. */
function tokenIsWord(token: string, word: string): boolean {
  const needle = word.toLowerCase();
  if (token === needle) return true;
  return TOKEN_TRIM_SUFFIXES.some((suffix) => token === `${needle}${suffix}`);
}

function tokenMatches(tokens: string[], word: string): boolean {
  return tokens.some((token) => tokenIsWord(token, word));
}

/**
 * 야구 신호어의 토큰 경계 매칭 (삼순 12차 P0).
 *
 * `compact.includes("아웃")`은 `아웃도어`, `도루`는 `도루묵`, `세이프`는 `세이프티`,
 * `번트`는 `번트케이크`까지 야구 신호로 오인해 범위 밖 질문을 provider/LLM/cache 로 흘렸다.
 * 그래서 신호어는 토큰 경계에서만 인정한다. 다만 `잔루만루는` 같은 복합 축약형을 계속
 * 살리기 위해, 토큰이 **야구 폐쇄 어휘만으로 완전히 분해될 때**에 한해 결합형도 허용한다.
 * 어휘 밖 잔여물(`도어`·`묵`·`티`·`케이크`)이 남으면 매칭하지 않는다.
 */
const BASEBALL_VOCABULARY: readonly string[] = Array.from(new Set([
  ...BASEBALL_WORDS,
  ...RULE_TERM_HINT_WORDS,
  ...RULE_SCOPE_SIGNAL_WORDS,
  ...RULE_ACTOR_WORDS,
].map((word) => word.toLowerCase())));

function stripTokenSuffix(token: string): string[] {
  const cores = [token];
  for (const suffix of TOKEN_TRIM_SUFFIXES) {
    if (token.length > suffix.length && token.endsWith(suffix)) {
      cores.push(token.slice(0, token.length - suffix.length));
    }
  }
  return cores;
}

/**
 * 신호어 뒤에 붙을 수 있는 **문법 꺼리**의 폐쇄 집합.
 *
 * 경계 검사를 순수 토큰 일치로만 두면 `만루면`·`잔루만루가뭔데`처럼 조사·어미가 붙은
 * 정상 질문까지 닫힌다. 반대로 아무 잔여물이나 허용하면 `아웃+도어`·`도루+묵`이 다시 새다.
 * 그래서 잔여물은 이 폐쇄 문법 단위로 **완전히 분해될 때만** 허용한다.
 * `도어`는 `도`+`어`로 쪼개지지 않고(`어`가 비문법 단위), `묵`·`티`·`케이크`도 없다.
 */
const GRAMMATICAL_TAIL_UNITS: readonly string[] = [
  "은", "는", "이", "가", "을", "를", "에", "의", "도", "만", "과", "와",
  "으로", "로", "에서", "에게", "한테", "부터", "까지", "처럼", "보다",
  "랑", "이랑", "나", "이나", "야", "이야", "요", "이에요", "예요",
  "면", "이면", "라면", "이라면", "라서", "이라서", "라고", "이라고",
  "이라는", "이란", "란", "인데", "인가", "일때", "일수", "이며",
  "뭔데", "뭐야", "뭐", "뭔가요", "뭐예요", "뭐임", "무슨", "뜻",
  // 서로 붙는 서술 꺼리(`보크하면`·`번트대면`·`도루했을`). 명사 연속(`도어`·`묵`·`케이크`)은
  // 이 집합에 없으므로 범위 밖 합성어는 여전히 닫힌다.
  "하", "해", "한", "할", "함", "하면", "해도", "하고", "하는", "했", "했을", "하기",
  "되", "돼", "된", "될", "됨", "되면", "돼도", "되고", "되는", "됐", "되나", "되죠",
  "이다", "이고", "이지", "지", "다면", "이라도", "라도", "대면", "인지", "인가요",
];

function isGrammaticalTail(rest: string): boolean {
  if (rest.length === 0) return true;
  return GRAMMATICAL_TAIL_UNITS.some((unit) =>
    rest.startsWith(unit) && isGrammaticalTail(rest.slice(unit.length))
  );
}

/**
 * `core`가 폐쇄 야구 어휘(+문법 꺼리)로만 분해되며 그 조각에 `needle`이 포함되는지.
 * `잔루만루가뭔데` = 잔루 + 만루 + (가뭔데) → 허용, `아웃도어` = 아웃 + (도어) → 차단.
 */
function decomposesWithNeedle(core: string, needle: string): boolean {
  const seen = new Map<string, boolean>();
  const walk = (rest: string, usedNeedle: boolean): boolean => {
    if (usedNeedle && isGrammaticalTail(rest)) return true;
    if (rest.length === 0) return false;
    const key = `${rest}|${usedNeedle ? 1 : 0}`;
    const cached = seen.get(key);
    if (cached !== undefined) return cached;
    let ok = false;
    for (const word of BASEBALL_VOCABULARY) {
      if (!rest.startsWith(word)) continue;
      if (walk(rest.slice(word.length), usedNeedle || word === needle)) {
        ok = true;
        break;
      }
    }
    seen.set(key, ok);
    return ok;
  };
  return walk(core, false);
}

/**
 * `순위 결정 규칙`처럼 복합 신호어(`순위결정`·`비디오판독`·`희생플라이`)를 띄어쓰면 단일
 * 토큰으로 잡히지 않는다. 그래서 인접 토큰 창(최대 3)을 결합해서도 매칭한다. 결합은
 * 연속된 토큰에만 적용되므로 `아웃도어`처럼 한 토큰 안에서 어휘 밖 잔여물이 남는
 * 경우는 여전히 닫힌다.
 */
const MAX_SIGNAL_TOKEN_SPAN = 3;

/**
 * 결함주입 전용 스위치 (게이트 검증력 증명용).
 *
 * `BASEBALL_QA_MUTATE_SUBSTRING_SCOPE=1` 이면 토큰 경계 검사를 과거의 `includes()` 부분문자열
 * 매칭으로 되돌린다. 이때 `아웃도어`·`도루묵`·`세이프티`·`번트케이크`가 다시 야구 질문으로
 * 오인되어 actual matrix 가 RED 로 죽어야 한다. RED 가 안 나면 그 게이트는 false-green 이다.
 * 운영 경로에는 영향이 없고(기본값 off), QA 프로세스에서만 사용한다.
 */
const MUTATE_SUBSTRING_SCOPE = process.env.BASEBALL_QA_MUTATE_SUBSTRING_SCOPE === "1";

/**
 * 2차 가드 결함주입 스위치 (게이트 검증력 증명용).
 *
 * 룰베이스가 못 가린 질문(`llm_scope_gate`)의 처리를 과거 두 상태로 되돌린다.
 * 둘 다 actual matrix가 RED로 죽어야 이 경계를 진짜로 검증하고 있다는 증거가 된다.
 *   `blocked` — #1091 이전 동작(미매칭 전부 차단). 사전 미수록 정상 룰 질문이 과차단된다.
 *   `open`    — main 동작(미매칭 fail-open). 비야구 질문이 공식 RAG(tier1 조문)·global
 *                cache 경계 안으로 들어간다(삼순 R1/R2 재현).
 * 기본값 off — 운영 경로에는 영향이 없다.
 */
const MUTATE_SCOPE_GATE = process.env.BASEBALL_QA_MUTATE_SCOPE_GATE ?? "";

function mentionsSignalWord(tokens: string[], word: string): boolean {
  const needle = word.toLowerCase();
  if (MUTATE_SUBSTRING_SCOPE) {
    return tokens.join("").includes(needle);
  }
  for (let start = 0; start < tokens.length; start++) {
    const span = Math.min(MAX_SIGNAL_TOKEN_SPAN, tokens.length - start);
    for (let size = 1; size <= span; size++) {
      const window = tokens.slice(start, start + size);
      const head = window.slice(0, size - 1).join("");
      const matched = stripTokenSuffix(window[size - 1]).some((tail) => {
        const core = `${head}${tail}`;
        return core === needle || decomposesWithNeedle(core, needle);
      });
      if (matched) return true;
    }
  }
  return false;
}

/**
 * 공백 포함 canonical 이름(roster 878명 중 28건, 예 "토다 나츠키")을 연속 토큰으로 매칭한다.
 * 단일 토큰 비교만 하면 이름이 질문에서 두 토큰으로 쪼개져 exact 미스 → history_hold를
 * 우회해 LLM으로 누수된다 (삼순 2차 P0). 토큰 단위 비교라 단어 경계는 그대로 지키고,
 * 마지막 토큰에만 기존 허용 조사 경계를 적용한다 ("미치 화이트가").
 */
function tokensContainSequence(tokens: string[], parts: string[]): boolean {
  const last = parts.length - 1;
  for (let start = 0; start + parts.length <= tokens.length; start++) {
    let matched = true;
    for (let offset = 0; offset <= last; offset++) {
      const token = tokens[start + offset];
      const part = parts[offset];
      const ok = offset === last ? tokenMatches([token], part) : token === part;
      if (!ok) { matched = false; break; }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * 질문이 지목한 로스터 선수 전부를 돌려준다.
 * 선수명·KBO ID에 일반 단어와 동일한 허용 조사 경계(tokenMatches)를 적용한다.
 * "김도영의", "류현진은", "박해민이", "52605의" 같은 조사 결합형이 exact 미스로
 * history_hold를 우회해 LLM/캐시에 진입하는 것을 막는다 (삼순 3차 P0).
 *
 * 존재 판정(history_hold)뿐 아니라 RAG entity 해석에도 같은 매칭을 쓴다 — 두 경로가
 * 서로 다른 이름 매칭을 쓰면 한쪽만 통과하는 우회가 생긴다.
 */
export function findPlayerReferences(tokens: string[], players: PlayerRef[]): PlayerRef[] {
  return players.filter((player) => {
    const nameParts = questionTokens(player.name);
    const kboId = player.kboId.normalize("NFKC").toLowerCase().trim();
    if (kboId.length >= 3 && tokenMatches(tokens, kboId)) return true;
    if (nameParts.length === 0) return false;
    if (nameParts.join("").length < 2) return false;
    return nameParts.length === 1
      ? tokenMatches(tokens, nameParts[0])
      : tokensContainSequence(tokens, nameParts);
  });
}

function hasPlayerReference(tokens: string[], players: PlayerRef[]): boolean {
  return findPlayerReferences(tokens, players).length > 0;
}

export type UnboundName = {
  /** 질문에서 뽑힌, 로스터에 없는 이름 오타 */
  token: string;
  /** 그 오타가 가리키는 현 로스터 선수 이름 */
  suggestion: string;
};

/**
 * **실측 오타 alias map** — 운영 로그에서 확인된 것만.
 *
 * ── 왜 규칙이 아니라 map 인가 (삼순 2026-08-09 최종 수렴안) ──────────────────
 *
 *   이 PR 에서 이름 판정 규칙을 여섯 번 바꿨다:
 *     성씨 결속 → 첫 어절 → 담화 표지 → near-miss 무조건 → query-wide anchor
 *     → candidate-local anchor
 *   매번 반례가 하나 나오면 규칙을 하나 더 붙였고, 그때마다 새 반례가 나왔다.
 *   마지막 전제("한국어 관형형 뒤에는 관형사가 안 온다")도 틀렸다 —
 *   `우승한 그 선수 누구야?`·`우승한 어떤 선수야?` 는 자연스러운 문장이다.
 *
 *   ⚠️ **운영 로그 실측이 이 접근을 끝냈다.** genius_question_logs 3,297행
 *   (unique 2,576) 에서 "답변 못 한 질문 × 로스터 이름과 1음절 차이" 를 전수로 뽑으니
 *   69개 토큰이 나왔는데, 그중 **실제 사람 이름 오타는 2개뿐**이었다:
 *
 *      47회  보크  → 보스     "보크가 뭐냐고?"          ← 야구 용어
 *      19회  주자  → 주권     "1루에 주자 있고…"        ← 야구 용어
 *      19회  삼진  → 박진     "삼진으로 아웃됐음"        ← 야구 용어
 *       5회  해줘  → 해치  /  5회 제일 → 네일  /  4회 페어 → 페덱
 *       4회  어디서→ 어준서 /  3회 주루 → 주권  /  2회 규정 → 최정   …(66종)
 *      ─────────────────────────────────────────────────────────
 *       1회  임창규 → 임찬규   ← 하린아빠 제보 원형
 *       1회  양혅종 → 양현종   ← 진짜 오타
 *
 *   즉 near-miss 로 열면 `보크가 뭐야` 에 "혹시 보스 선수를?" 이 **47번** 나갔을 것이다.
 *   그리고 `보크가 뭐야` 는 조사형이라 어떤 anchor 규칙을 짜도 통과한다.
 *   규칙으로는 닫히지 않는다는 게 데이터로 확정됐다.
 *
 * ── 계약 ──────────────────────────────────────────────────────────────────
 *   • 여기 실린 것만 되묻는다. 규칙 추론 없음 → 오제안 구조적으로 0.
 *   • 값(교정 대상)은 **현 로스터에 존재해야** 한다. 은퇴·이적으로 사라지면
 *     fail-close 로 조용히 빠진다(없는 선수를 되묻지 않는다).
 *   • 확장은 **운영 로그 실측**으로만. 지어낸 오타를 넣지 않는다.
 *
 * ⚠️ 일반화(로스터 밖 실존 인물·완전 허구 이름 차단)는 형태소/NER 이 필요하고
 *   **별도 트랙**이다. 이 PR 은 그걸 하지 않는다 — 손해는 게이트에 actual 로 고정했다.
 */
//
// ⚠️ **출처는 토큰만 남긴다.** 각 항목이 어느 질문에서 나왔는지는 적지 않는다 —
//   비공개 user-generated 로그 원문을 repo 에 복제하면 안 된다(삼순 2026-08-09).
//   확장할 때도 오타 토큰과 교정 대상만 옮겨 적는다.
const MEASURED_TYPO_ALIASES: ReadonlyMap<string, string> = new Map([
  // 하린아빠 제보 원형(match_path=llm) — generic LLM 이 없는 사람을 실존으로 만들었다.
  ["임창규", "임찬규"],
  // 운영 로그 실측 오타(match_path=llm).
  ["양혅종", "양현종"],
]);

/**
 * 질문 안의 **실측된 이름 오타**를 찾는다. 있으면 생성 없이 그 이름을 되묻는다.
 *
 * ── 왜 필요한가 (2026-08-08 하린아빠 제보, Production 재현) ────────────────
 *   `임창규 어떤 선수야`  →  route=llm_scope_gate  →  generic LLM 이
 *   "임창규는 LG 트윈스의 주축 선수" 라고 **없는 사람을 실존으로 만들었다.**
 *   결속된 근거가 0 인 상태에서 실명에 대해 생성이 일어난 것 자체가 P0 다.
 *   유저는 그게 틀렸다는 걸 알 방법이 없다 — 수치 환각보다 나쁘다.
 *
 * 판정은 위 `MEASURED_TYPO_ALIASES` 조회 하나다. 어투·위치·품사를 보지 않으므로
 * `임창규 알려줘`·`혹시 임창규 어떤 선수야`·`임창규는 어느 팀이야` 가 전부 잡히고,
 * 반대로 map 에 없는 `우승한`·`보크`·`자동차` 는 **구조적으로** 잡히지 않는다.
 */
export function resolveUnboundName(
  question: string,
  players: PlayerRef[],
): UnboundName | null {
  const tokens = questionTokens(question.normalize("NFKC").toLowerCase());
  const rosterNames = new Set(players.map((p) => p.name));

  for (const raw of tokens) {
    // 조사를 떼어낸 핵도 본다 — `임창규는 어느 팀이야`.
    for (const token of stripTokenSuffix(raw)) {
      const suggestion = MEASURED_TYPO_ALIASES.get(token);
      if (suggestion === undefined) continue;
      // ⚠️ **오타 키가 실존 선수 이름이면 되묻지 않는다.** 로스터는 매일 바뀐다 —
      //   지금은 오타인 문자열이 내일 신인 이름일 수 있다. 그때 그 선수를 물은 유저에게
      //   "혹시 다른 사람?" 이라고 되묻는 것은 이 PR 이 고치려던 결함의 거울상이다.
      if (rosterNames.has(token)) continue;
      // ⚠️ 교정 대상이 **지금** 로스터에 있어야 한다. 은퇴·이적하면 되묻지 않는다 —
      //   없는 선수를 되묻는 것은 이 PR 이 고치려던 그 결함과 같은 종류다.
      if (!rosterNames.has(suggestion)) continue;
      return { token, suggestion };
    }
  }
  return null;
}

/**
 * RAG 서빙 대상 선수를 해석한다. 답이 나오려면 **정확히 한 명**으로 좁혀져야 한다.
 *
 * 동명이인(로스터에 같은 이름이 둘 이상)이면 `null`이다 — 이름 단독으로 한 명을 고르는 것은
 * 스펙 §12 동명이인 격리 계약 위반이며, 엉뚱한 선수 문서로 답하게 된다.
 * 두 명 이상을 언급한 질문("A가 잘해 B가 잘해?")도 단일 entity 근거로 답할 수 없어 제외한다.
 */
export function resolveRagPlayerCandidate(
  question: string,
  players: PlayerRef[],
): RagPlayerCandidate | null {
  if (!isDescriptivePlayerQuestion(question)) return null;
  return resolveNamedPlayerCandidate(question, players);
}

/**
 * 질문 의도와 무관하게 **이름으로 단일 선수가 특정되는가**만 본다.
 *
 * 서술형 게이트(`isDescriptivePlayerQuestion`)는 숫자·수치어가 있으면 거지하는데, 그건
 * **tier2(나무위키) 서빙 조건**이지 선수 식별 조건이 아니다. 기록 질문(`문보경 올해 2루타
 * 몇개칩어?`)은 수치어 때문에 그 게이트에 걸려 후보 자체가 안 잡혔고, 그래서 구조화 DB
 * 경로까지 도달하지 못했다(게이트가 잡은 결함).
 */
/**
 * 질문 문장에 **로스터 선수 이름이 하나라도 명시**돼 있는가 — 입단 후속 과결속 차단용.
 *
 * ⚠️ `resolveNamedPlayerCandidate === null` 과 다르다. resolve 는 복수 이름·동명이인도
 *   null 을 주는데, 그건 "명시 엔티티 없음"이 아니라 "명시됐는데 모호함"이다. 모호한
 *   질문이 직전 선수로 새면 엉뚱한 입단 연도가 확정 문장으로 나간다(삼순 2026-08-09).
 *   방향은 보수적이다 — 과탐(이름 아닌 문자열을 이름으로 오인)은 후속 미결속 → 기존
 *   경로 유지일 뿐이고, 미탐이 사고다. 정확 부분문자열만 보고 근접 매칭은 하지 않는다.
 */
export function mentionsAnyRosterName(question: string, players: PlayerRef[]): boolean {
  const normalized = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return players.some((player) => {
    const name = player.name?.normalize("NFKC").toLowerCase() ?? "";
    return name.length >= 2 && normalized.includes(name);
  });
}

export function resolveNamedPlayerCandidate(
  question: string,
  players: PlayerRef[],
): RagPlayerCandidate | null {
  const normalized = question.normalize("NFKC").toLowerCase();
  const tokens = questionTokens(normalized);
  const matched = findPlayerReferences(tokens, players);
  const distinctIds = new Set(matched.map((player) => player.kboId));
  if (distinctIds.size !== 1) return null;
  const target = matched[0];
  return buildCandidate(target, normalized, players);
}

function buildCandidate(
  target: PlayerRef,
  normalized: string,
  players: PlayerRef[],
): RagPlayerCandidate | null {

  // 토큰 매칭은 허용 조사 목록에 없는 결합형("문보경이랑")을 놓친다. history_hold에서는
  // 한 명만 걸려도 결과가 같지만, RAG는 "이 질문이 정말 한 선수만 가리키는가"가 정확도의 전제다.
  // 따라서 조사와 무관하게 다른 선수 이름이 문자열로 등장하면 단일 entity로 보지 않는다.
  // 판정을 보수적으로만 움직인다 — 과탐지는 RAG 미서빙(기존 경로 유지)을 만들 뿐이고,
  // 놓치면 남의 문서로 답하는 사고가 된다.
  const mentionsOther = players.some((player) =>
    player.kboId !== target.kboId &&
    player.name.length >= 2 &&
    player.name !== target.name &&
    normalized.includes(player.name.normalize("NFKC").toLowerCase()) &&
    // 대상 선수 이름의 부분문자열일 뿐인 경우("양현" ⊂ "양현종")는 제외한다.
    !target.name.includes(player.name));
  if (mentionsOther) return null;

  // 같은 이름이 로스터에 둘 이상이면 kboId가 갈려 distinctIds 검사에서 이미 걸러졌다(동명이인 격리).
  return {
    entityType: "player",
    entityId: target.kboId,
    name: target.name,
    ...(target.team ? { team: target.team } : {}),
    sourceKey: `namu:player:${target.kboId}`,
  };
}

/** picker 선택지 상한. 로스터 최대 동명이인 그룹이 3명(김동현·김태훈 등)이라 여유를 둔 값. */
export const PLAYER_PICKER_MAX_OPTIONS = 6;

/**
 * 동명이인으로 **선수를 특정하지 못한** 서술형 질문인지 판정하고, 그렇다면 선택지를 돌려준다.
 *
 * `resolveRagPlayerCandidate`는 후보 kboId가 2개 이상이면 null을 돌려 그대로 끝낸다. 그러면
 * `김동현 어떤 선수야?`가 이유 설명 없이 차단 문구로 끝난다. 여기서는 대신 "어느 김동현인가"를
 * 되묻고, 유저가 고른 kboId로 다시 특정해 답한다(하린아빠 2026-08-03 지시).
 *
 * ⚠️ 추측으로 한 명을 고르지 않는다. 낙업률 높은 선수를 기본값으로 잡으면 남의 문서로
 * 답하는 사고가 조용히 나며, 유저는 그게 틀렸는지도 모른다. 모호하면 물어본다.
 */
export function resolvePlayerPickerOptions(
  question: string,
  players: PlayerRef[],
  /**
   * 서술형 게이트를 건너뛴지 여부. 기록 질문은 수치어 때문에 서술형 게이트에 걸리지만,
   * 동명이인 모호성은 똑같이 존재한다 — 오히려 기록은 동명이인도 답할 수 있어
   * (Production 실측: 72명 중 28명 타자기록 보유) picker 가 실제로 값을 한다.
   */
  allowNonDescriptive = false,
): PlayerPickerOption[] | null {
  if (!allowNonDescriptive && !isDescriptivePlayerQuestion(question)) return null;
  const normalized = question.normalize("NFKC").toLowerCase();
  const tokens = questionTokens(normalized);
  const matched = findPlayerReferences(tokens, players);
  if (matched.length === 0) return null;

  // 서로 다른 **이름**이 여럿 걸렸다면 동명이인이 아니라 `A와 B 중 누가~` 같은 비교 질문이다.
  // 그건 picker로 풀 문제가 아니므로 기존 차단 경로에 맡긴다.
  const names = new Set(matched.map((player) => player.name));
  if (names.size !== 1) return null;

  const distinct = new Map<string, PlayerRef>();
  for (const player of matched) distinct.set(player.kboId, player);
  // 1명이면 모호하지 않다 — 기존 단일 후보 경로가 그대로 처리한다.
  if (distinct.size < 2) return null;
  // 상한을 넘으면 고르게 하는 것 자체가 의미가 없다 — 기존 차단으로 둘려보낸다.
  if (distinct.size > PLAYER_PICKER_MAX_OPTIONS) return null;

  // 다른 선수까지 같이 언급된 문장은 단일 엔티티 질문이 아니므로 picker 대상이 아니다.
  const targetName = matched[0].name;
  const mentionsOther = players.some((player) =>
    player.name !== targetName &&
    player.name.length >= 2 &&
    normalized.includes(player.name.normalize("NFKC").toLowerCase()) &&
    !targetName.includes(player.name));
  if (mentionsOther) return null;

  return [...distinct.values()]
    .map((player) => ({
      kboId: player.kboId,
      name: player.name,
      team: player.team ?? null,
      position: player.position ?? null,
      backNo: player.backNo ?? null,
    }))
    // 표시 순서를 kboId로 고정한다 — 로스터 파일 순서가 바뀌어도 같은 화면이 나오게.
    .sort((left, right) => left.kboId.localeCompare(right.kboId));
}

/**
 * picker 선택 뒤 재질의에서 온 kboId로 후보를 직접 구성한다.
 *
 * 이름 매칭을 건너뛰는 게 핵심이다 — 이름으로 다시 풀면 또 동명이인으로 갈라져 picker가
 * 무한히 반복된다. 유저가 명시적으로 고른 id만 신뢰하고, 로스터에 없는 id는 거절한다.
 */
export function isPickedPlayerAllowed(
  question: string,
  kboId: string,
  players: PlayerRef[],
): boolean {
  // 원 질문에서 서버가 다시 계산한 picker 후보군에 속한 id만 허용한다.
  // `allowNonDescriptive=true`는 기록 질문(수치어가 있어 descriptive 게이트 거부)도 포함한다.
  const options = resolvePlayerPickerOptions(question, players, true);
  return options?.some((option) => option.kboId === kboId) ?? false;
}

export function resolvePickedPlayerCandidate(
  kboId: string,
  players: PlayerRef[],
): RagPlayerCandidate | null {
  const target = players.find((player) => player.kboId === kboId);
  if (!target) return null;
  return {
    entityType: "player",
    entityId: target.kboId,
    name: target.name,
    ...(target.team ? { team: target.team } : {}),
    sourceKey: `namu:player:${target.kboId}`,
  };
}

/**
 * 구단 답변 고유의 야구 신호어.
 *
 * ⚠️ 왜 필요한가 (삼순 #1100 3차 P0-1 실측):
 * `hasBaseballSignal` 은 **LLM 답변 본문**의 최종 안전판이다. 그런데 신호어가 룰·용어
 * 어휘(`BASEBALL_WORDS`)뿐이라, 프롬프트에서 구단을 열어줘도 정상 구단 답변이 여기서
 * 다시 폐기됐다:
 *   `LG 트윈스 감독은 염경엽입니다.`            → unsure
 *   `LG 트윈스는 1990년 창단한 KBO 구단입니다.` → unsure
 * 즉 라우터·프롬프트를 다 고쳐도 **유저는 여전히 차단 문구를 받는다**.
 *
 * 그래서 구단 답변에 자연스럽게 나타나는 신호를 여기 더한다. 어휘 범위를 무작정 넓히지
 * 않고 **구단·리그 고유명사 축**만 여는다 — `날씨`·`맛집` 같은 범위밖 답변은 여전히
 * 이 신호가 없어 걸러진다(문장에 구단명이 섞여도 NOT_BASEBALL sentinel 이 앞서 닫는다).
 */
/**
 * 답변 본문이 **주제를 벗어난** 신호.
 *
 * 신호어 allowlist 를 넓히는 방향은 3차에 실패했다 — `리그` 를 넣었더니
 * `리그 오브 레전드는 인기 게임입니다.` 가 통과했다(삼순 4차 P0-1).
 * 그래서 완화 경로에서는 allowlist 가 아니라 **주제이탈 denylist** 로 닫는다.
 */
const ANSWER_OFF_TOPIC =
  new RegExp(
    [
      // 범위밖 주제
      "게임", "영화", "드라마", "예능", "아이돌", "맛집", "음식", "메뉴", "레시피", "요리",
      "날씨", "기온", "주식", "주가", "코인", "부동산", "여행", "숙소", "쇼핑", "배송",
      "스마트폰", "노트북", "갤럭시", "프롬프트", "비밀번호",
      // 선수 개인 신상·상거래 — 질문에 야구 신호가 있어도 답변은 범위 밖이다
      // (삼순 2026-08-08 적대 표본: 연봉·여자친구·티켓·세탁).
      "연봉", "계약금", "여자친구", "남자친구", "열애", "티켓", "입장권", "예매",
      "세탁", "채용", "취업",
      // 타 종목 — `선수` 앵커가 야구 밖에서도 쓰이기 때문에 필요하다
      // (`선수는 e스포츠 리그에서 활동합니다.` 실측). AND 조건이라 목록이 불완전해도
      // 판정이 종전보다 느슨해지지는 않는다.
      "축구", "농구", "배구", "골프", "테니스", "격투기", "e스포츠", "이스포츠", "esports",
    ].join("|"),
    "u",
  );

/**
 * **답변측 고정밀 앵커** (SSOT) — 삼순 2026-08-08.
 *
 * 왜 이 축인가. 실측(2026-08-08)에서 `unsure` 로 폐기된 정상 답변들은 전부 여기에 걸린다:
 *   `SK 와이번스는 … KBO 구단으로 …`        → `kbo`·`구단`
 *   `문현빈은 한화 이글스 소속의 내야수예요.` → `내야수`
 *   `유격수는 shortstop 의 약자예요.`         → `유격수`
 * 종전 `BASEBALL_WORDS` 는 룰·용어 어휘라 **구단·선수 답변에는 안 나타나는 말들**이었다.
 * 라우터·프롬프트를 다 고쳐도 답변이 여기서 죽는 구조였다.
 *
 * ⚠️ **넓은 말은 넣지 않는다.** 3차에 `리그` 를 넣었다가 `리그 오브 레전드는 인기
 * 게임입니다.` 가 통과했다(삼순 4차 P0-1). 여기 들어갈 자격은 **야구 밖에서 거의 안
 * 쓰이는 말**이다 — `구단`·`유격수`·`내야수` 는 야구 밖 문장에 나올 일이 없고,
 * `kbo` 는 리그 고유명사다. 반대로 `팀`·`경기장`·`시즌`·`기록` 같은 말은 자격이 없다.
 *
 * ⚠️ 그리고 **양성 신호를 음성 목록(denylist)으로 바꾸지 않는다.** "질문에 야구 신호가
 * 있으면 답변은 denylist 로만 본다" 는 방향은 삼순 NO-GO 다 — `연봉`·`여자친구`·`티켓`·
 * `세탁` 처럼 목록에 없는 말이 무한히 나오고, 목록을 늘리는 싸움은 수렴하지 않는다.
 */
/**
 * **단독으로 인정되는 고정밀 앵커** — 야구 밖에서는 사실상 쓰이지 않는 말만.
 *
 * ⚠️ 자격 기준: 이 단어가 들어간 **비야구 문장을 만들 수 있으면 자격이 없다.**
 *   `구단`·`선수`·`선발`·`마무리` 를 넣었다가 삼순이 바로 반증했다(2026-08-08 실측):
 *     `박태환은 수영 선수입니다`            → 통과
 *     `FC 서울은 한국의 프로 구단입니다`    → 통과
 *     `김민재는 국가대표 선발 선수입니다`   → 통과
 *   denylist 를 AND 로 써도 `수영`·`FC 서울`·`국가대표` 를 다 적을 수는 없다.
 *   그래서 범용어는 여기서 뺀다 — 대신 아래 `ANSWER_SCOPE_QUALIFIED_ANCHORS` 로 옮긴다.
 */
const ANSWER_SCOPE_ANCHORS = [
  // 리그·조직 고유명사 — `프로야구`·`kbo` 는 야구를 지칭하는 말 그 자체다.
  "kbo", "프로야구",
  // 포지션 — 야구 전용. `유격수`·`내야수` 는 다른 종목에 없다.
  "유격수", "내야수", "외야수", "포수", "1루수", "2루수", "3루수", "지명타자",
  // ⚠️ `투수`·`타자` 는 야구 전용이라 남긴다(소프트볼 정도가 예외이나 우리 도메인 밖이다).
  "투수", "타자",
  //
  // ⚠️ 여기 **없는** 말들과 그 이유:
  //   `구단`·`선수`·`선발`·`불펜`·`마무리`  → 타 종목·일반 문장에서 쓰인다 (아래 qualified)
  //   `감독`·`코치`·`주장`·`구단주`         → `축구 국가대표 감독은 홍명보입니다.` 가 통과
  //   `리그`                                → `리그 오브 레전드는 인기 게임입니다.` (삼순 4차)
];

/**
 * **한정 앵커** — 단독으로는 인정하지 않고, 위 고정밀 앵커나 **KBO 구단명과 함께
 * 나타날 때만** 야구 신호로 친다 (삼순 2026-08-08: "선수/구단은 그 앵커와 동시 등장할 때만").
 *
 *   `구자욱 선수입니다.`                    → 한정 앵커뿐 → 인정 안 함(fail-close)
 *   `LG 트윈스 주장은 구자욱 선수입니다.`   → 구단명 + 선수 → 인정
 *   `박태환은 수영 선수입니다`              → 한정 앵커뿐 → 인정 안 함
 *
 * 축약 답변이 닫히는 손해는 **프롬프트**가 메운다 — 판정 프롬프트가 첫 문장에 야구/KBO
 * 문맥을 밝히도록 강제하므로 provider 는 `LG 트윈스 주장은 …` 형태로 보낸다.
 */
const ANSWER_SCOPE_QUALIFIED_ANCHORS = [
  "구단", "선수", "선발", "불펜", "마무리", "구단주", "감독", "코치", "주장",
  // 삼순 2026-08-08 2차 P0 — 단독 허용에서 내려온 네 단어. 위 `ANSWER_EXCLUSIVE_TERMS`
  // 주석의 반증 문장 참조. `잠실야구장은 LG 트윈스의 홈 구장입니다` 처럼 확정 신호가
  // 같이 오면 그대로 산다.
  "구장", "투구", "주자", "대타",
];

/**
 * 답변 문장의 **서술어 꼬리** — `구자욱 선수입니다.` 의 `입니다` 같은 것.
 *
 * 질문 토큰 꼬리(`TOKEN_TRIM_SUFFIXES`)에는 없다. 그 목록은 **질문** 어절을 위한 것이고
 * (`보크가`·`보크는`), 답변은 서술어로 끝나기 때문이다. 앵커 매칭에만 추가로 허용한다 —
 * 질문측 판정을 건드리면 라우팅 전체가 흔들린다.
 */
const ANSWER_PREDICATE_TAILS = [
  "입니다", "이에요", "예요", "이예요", "였어요", "이었어요", "래요", "이래요", "임", "이다",
];

function matchesAnswerAnchor(tokens: string[], word: string): boolean {
  if (tokenMatches(tokens, word)) return true;
  return tokens.some((token) =>
    ANSWER_PREDICATE_TAILS.some((tail) => token === `${word}${tail}`));
}

/**
 * **답변 전용 폐쇄 어휘** — 야구 밖 문장에 사실상 나타나지 않는 룰·용어만.
 *
 * ⚠️ 왜 `BASEBALL_WORDS` 를 재사용하지 않는가 (삼순 2026-08-08 P0, 실측 반증):
 * `BASEBALL_WORDS` 와 범용 경기어(`경기`·`득점`·`수비`)는 **질문 라우팅용**이다. 질문은
 * 우리 봇에게 온 것이라 야구 맥락이 전제되지만, **답변 본문**은 그 전제가 없다. 그대로
 * 재사용했더니 아래가 전부 통과했다:
 *   `손흥민은 어제 경기에서 득점했습니다.`            → `경기`·`득점`
 *   `박태환은 올림픽 기록을 세운 수영 선수입니다.`   → `기록`
 *   `베이스 기타는 4현 악기로 …`                     → `베이스`
 *   `김민재는 국가대표 수비의 핵심입니다.`           → `수비`
 * 즉 답변측 안전판이 질문측 어휘에 얹혀 있어서 **타 종목 답변을 그대로 서빙**했다.
 *
 * 자격 기준은 고정밀 앵커와 같다 — **이 단어가 든 비야구 문장을 만들 수 있으면 자격 없음.**
 * 그래서 여기 **없는** 말들: `기록`·`스탯`·`war`·`abs`·`베이스`·`수비`·`경기`·`득점`·
 * `공격`·`아웃`·`파울`·`태그`·`세이프`·`엔트리`·`로스터`·`시프트`·`심판`·`스트라이크`.
 * 이 말들이 빠져서 닫히는 정상 답변은 구단명·포지션·`야구` 어느 하나를 대개 함께 갖는다
 * (프롬프트가 첫 문장에 야구 문맥을 강제한다).
 */
const ANSWER_EXCLUSIVE_TERMS = [
  "야구", "야구장", "홈런", "안타", "이닝", "타석", "타점", "보크", "번트",
  "도루", "병살", "주루", "홈플레이트", "마운드", "볼넷", "낫아웃", "인필드플라이",
  "희생플라이", "태그업", "피치클락", "타율", "방어율", "평균자책", "대주자",
  // 룰·용어 답변의 자기 문맥 — `잔루는 공격이 끝났을 때 루상에 남은 주자예요.` 처럼
  // 질문 용어를 답변이 다시 말해준다. 전부 복합어라 비야구 문장을 만들 수 없다.
  "잔루", "만루", "루상", "출루", "타순", "주루플레이", "무사구", "완투",
  //
  // ⚠️ 여기 **없는** 말과 그 이유 (삼순 2026-08-08 2차 P0 실측 반증):
  //   `구장` → `서울월드캵경기장은 전용 구장입니다`
  //   `투구` → `고대 로마 병사의 투구는 금속입니다`   (兜胄 동음이의어)
  //   `주자` → `계주 마지막 주자는 김민지입니다`
  //   `대타` → `박철수는 행사 사회자 대타입니다`
  // 네 단어는 `ANSWER_SCOPE_QUALIFIED_ANCHORS` 로 옮겨 **확정 신호와 결합할 때만** 인정된다.
  // `야구장` 은 남긴다 — 복합어라 비야구 문장을 만들 수 없다.
];

/**
 * 답변 본문에 야구 신호가 있는가 — **답변 전용 어휘와 고정밀 앵커로만** 판정한다.
 * 질문측 어휘(`BASEBALL_WORDS`)·범용 경기어는 쓰지 않는다(위 주석의 반증 참조).
 */
function hasAnswerBaseballSignal(value: string): boolean {
  const tokens = questionTokens(value);
  return ANSWER_EXCLUSIVE_TERMS.some((word) => matchesAnswerAnchor(tokens, word)) ||
    ANSWER_SCOPE_ANCHORS.some((word) => matchesAnswerAnchor(tokens, word));
}

/**
 * 답변에 **야구를 확정하는 신호**가 있는가 — 고정밀 앵커 또는 KBO 구단명.
 * 한정 앵커(`선수`·`구단`)는 이 신호가 같이 있을 때만 인정된다.
 */
/**
 * **답변측 구단 신호** — 같은 팀의 약칭+별칭 쌍이 함께 나타날 때만 인정한다.
 *
 * ⚠️ 왜 질문용 `mentionsTeam` 을 쓰면 안 되는가 (삼순 2026-08-08 3차 P0, 실측 반증):
 * `mentionsTeam` 은 **단독 약칭·별칭**도 구단으로 인정한다. 질문은 우리 봇에 온 것이라
 * `LG` 한 마디가 구단을 뜻하지만, **답변 본문**은 그 전제가 없다:
 *   `LG는 한국의 가전 기업입니다`   → 통과  (약칭 `lg`)
 *   `기아는 자동차 회사입니다`     → 통과  (약칭 `기아`)
 *   `이글스는 미국의 록 밴드입니다`  → 통과  (별칭 `이글스`)
 * `삼성`·`롯데`·`한화`·`키움` 은 전부 실존 기업명이라 denylist 로는 막을 수 없다.
 *
 * 그래서 답변측은 **풀네임 쌍**을 요구한다. 띄어쓰기·붙여쓰기 둘 다 인정한다:
 *   `LG 트윈스 감독은 …`  → 인정 (별도 토큰 쌍)
 *   `lg트윈스의 역사는 …`  → 인정 (결합 토큰)
 * 교차조합(`LG 라이온즈`)은 같은 팀이 아니므로 인정하지 않는다.
 *
 * 역사 구단(`SK 와이번즈`)처럼 현재 alias 표에 없는 이름은 여기서 안 잡히지만,
 * 프롬프트가 첫 문장에 야구/KBO 문맥을 강제하므로 `kbo` 앵커로 산다.
 */
/**
 * 답변 토큰이 그 구단어인가. 질문 꼬리(`베어스는`)에 더해 **서술어 꼬리**도 허용한다.
 *
 * ⚠️ 자체 발견(2026-08-08) — 인접 쌍으로 좁히면서 `그 팀은 두산 베어스입니다.` 가 죽었다.
 *   `입니다` 는 질문 꼬리 목록(`TOKEN_TRIM_SUFFIXES`)에 없다 — 그 목록은 **질문** 어절용이고
 *   답변은 서술어로 끝나기 때문이다(`ANSWER_PREDICATE_TAILS` 가 같은 이유로 존재한다).
 *   답변측 판정에만 더한다 — 질문측 `tokenMatches` 는 그대로 둔다.
 */
function answerTokenIsTeamWord(token: string, word: string): boolean {
  if (tokenIsWord(token, word)) return true;
  const needle = word.toLowerCase();
  return ANSWER_PREDICATE_TAILS.some((tail) => token === `${needle}${tail}`);
}

function answerMentionsTeam(tokens: string[]): boolean {
  return TEAM_ALIASES.some(({ shorts, nicks }) => {
    // ① 결합 토큰 — `lg트윈스`·`두산베어스의`·`두산베어스입니다`
    const joined = tokens.some((token) =>
      shorts.some((short) => {
        if (!token.startsWith(short)) return false;
        const rest = token.slice(short.length);
        return nicks.some((nick) => {
          if (!rest.startsWith(nick)) return false;
          const tail = rest.slice(nick.length);
          return isGrammaticalTail(tail) || ANSWER_PREDICATE_TAILS.includes(tail);
        });
      }));
    if (joined) return true;
    // ② 별도 토큰 쌍 — `LG 트윈스`. **서로 붙어 있을 때만** 인정한다.
    //
    // ⚠️ 종전에는 "문장 어딘가에 약칭이 있고 어딘가에 별칭이 있으면" 통과시켰다. 그러면
    //   두 말이 **서로 다른 절**에 떨어져 있어도 풀네임으로 오인한다(삼순 2026-08-08 4차 P0):
    //     `LG는 가전 회사이고 트윈스는 쌈둥이라는 뜻입니다`  → 통과했다
    //     `삼성은 반도체 기업이고 라이온즈는 사자를 뜻합니다`  → 통과했다
    //   풀네임은 항상 한 덩어리로 쓰이므로 인접으로 좁혀도 정상 답변은 안 죽는다
    //   (`LG 트윈스 감독은 …`·`삼성 라이온즈는 대구를 …`).
    return tokens.some((token, index) => {
      const next = tokens[index + 1];
      if (next === undefined) return false;
      return shorts.some((short) => answerTokenIsTeamWord(token, short)) &&
        nicks.some((nick) => answerTokenIsTeamWord(next, nick));
    });
  });
}

function hasBaseballAnchorOrTeam(value: string, tokens: string[]): boolean {
  return hasAnswerBaseballSignal(value) || answerMentionsTeam(tokens);
}

/**
 * 답변이 범위 안인가 — **답변측 양성 신호**로만 판정한다.
 *
 * ⚠️ 2026-08-08 계약 변경 (삼순). 종전에는 `염경엽입니다.` 같은 짧은 답을 살리려고
 * "질문이 구단을 지명했으면 답변은 주제이탈 denylist 로만 본다" 는 우회를 뒀다.
 * 그 우회가 실제로 열려 있다는 반대가설이 나왔다(실측):
 *   `LG 티켓 가격 알려줘` → `LG 홈경기 티켓은 1만원부터 시작해요.` → **통과**
 * `티켓`·`연봉`·`여자친구`·`세탁` 은 denylist 에 없고, 넣어도 다음 단어가 또 나온다.
 * 양성 안전판을 불완전한 음성 목록으로 바꾸면 결국 다 열린다.
 *
 * 그래서 우회를 없애고 **정밀도를 올리는 쪽**으로 되돌린다:
 *  ① 답변에 야구 어휘 또는 고정밀 앵커(`ANSWER_SCOPE_ANCHORS`)가 있으면 통과.
 *  ② 없으면 fail-close. 짧은 답이 죽는 문제는 목록이 아니라 **프롬프트**로 푼다 —
 *     판정 프롬프트가 "첫 문장에서 야구/KBO 문맥을 밝히라" 고 강제하므로
 *     `염경엽입니다.` 는 `LG 트윈스 감독은 염경엽입니다.` 로 온다.
 *  ③ 그래도 앵커가 없으면 fail-close 를 유지한다 — 지어낸 답을 내보내는 것보다 낫다.
 *
 * `question` 인자는 호출부 계약 유지를 위해 남긴다(로그·후속 확장). 판정에는 쓰지 않는다 —
 * 질문 신호 단독으로 답변 검증을 우회시키지 않는 것이 이 함수의 핵심 계약이다.
 */
export function answerInQuestionScope(_question: string, answer: string): boolean {
  const normalized = answer.normalize("NFKC").toLowerCase();
  // ② 주제이탈은 앵커가 있어도 닫는다 — denylist 를 **AND 조건**으로 쓴다.
  //   (종전에는 앵커 대신 쓰는 **대체재**였고, 그게 `LG 티켓 가격` 이 새던 이유다.
  //    AND 로 쓰면 목록이 불완전해도 판정이 종전보다 느슨해지지 않는다.)
  //
  //   ⚠️ 다만 denylist 는 **보조**다. 이게 주 판정이 되면 목록에 없는 단어가 무한히
  //     새어나온다 — `수영`·`FC 서울` 을 다 적을 수는 없다. 주 판정은 아래 ①의 양성 신호다.
  if (ANSWER_OFF_TOPIC.test(normalized)) return false;
  const tokens = questionTokens(normalized);
  // ① 답변 자체의 야구 신호 — 룰·용어 어휘, 고정밀 앵커, 또는 KBO 구단명.
  //   `두산 베어스의 홈구장은 잠실야구장입니다.` 처럼 정상 구단 답변에는 룰 어휘가 없고
  //   구단명만 있다(#1100 에서 실제로 폐기되던 형태). 질문이 아니라 **답변에** 있을 때만
  //   인정한다 — 질문 신호 단독 bypass 는 삼순 NO-GO 다.
  if (hasBaseballAnchorOrTeam(answer, tokens)) return true;
  // ①-b 한정 앵커(`선수`·`구단`)는 **단독으로는 인정하지 않는다** (삼순 2026-08-08 P0).
  //   여기까지 왔다는 건 확정 신호가 없다는 뜻이므로, 한정 앵커가 있어도 닫는다.
  //   `박태환은 수영 선수입니다`·`FC 서울은 한국의 프로 구단입니다` 가 이 자리에서 죽는다.
  return false;
}

/** 게이트가 한정 앵커 계약을 직접 확인할 수 있게 노출한다(자기 재구현 금지). */
export function isQualifiedOnlyAnchorAnswer(answer: string): boolean {
  const normalized = answer.normalize("NFKC").toLowerCase();
  const tokens = questionTokens(normalized);
  if (hasBaseballAnchorOrTeam(answer, tokens)) return false;
  return ANSWER_SCOPE_QUALIFIED_ANCHORS.some((word) => matchesAnswerAnchor(tokens, word));
}

/**
 * 질문측 구단 지명 판정 (`mentionsTeam` + 야구 어휘 결합형).
 *
 * `mentionsTeam` 은 약칭+별칭 결합(`삼성라이온즈`)까지만 인정한다. 그런데 유저는
 * `삼성주장` 처럼 **구단+야구어를 붙여** 쓴다(오늘 실표본). 이런 토큰은 구단 지명으로
 * 안 잡혀 validator 완화가 안 먹힌다.
 *
 * ⚠️ 그렇다고 `startsWith(약칭)` 만 보면 `삼성전자 주가` 같은 범위밖까지 구단 질문이 된다.
 * 남는 꺼리가 **야구 폐쇄 어휘 + 문법 꺼리로만 분해**될 때만 인정한다:
 *   `삼성주장`   = 삼성 + 주장(RULE_ACTOR_WORDS)  → 구단 질문 ⭕️
 *   `삼성전자` = 삼성 + 전자(어휘 밖)          → 구단 질문 아님 ❌
 */
function questionMentionsTeam(tokens: string[]): boolean {
  if (mentionsTeam(tokens)) return true;
  return tokens.some((token) =>
    TEAM_WORDS.some((word) => {
      if (!token.startsWith(word) || token.length === word.length) return false;
      return decomposesIntoBaseballVocabulary(token.slice(word.length));
    }));
}

/** 남은 문자열이 야구 폐쇄 어휘(+문법 꺼리)로만 분해되는가. 빈 문자열은 인정하지 않는다. */
function decomposesIntoBaseballVocabulary(rest: string): boolean {
  if (rest.length === 0) return false;
  for (const word of BASEBALL_VOCABULARY) {
    if (!rest.startsWith(word)) continue;
    if (isGrammaticalTail(rest.slice(word.length))) return true;
    if (decomposesIntoBaseballVocabulary(rest.slice(word.length))) return true;
  }
  return false;
}

/**
 * LLM 전에 실행하는 결정론적 라우터.
 * 인젝션·서비스·선수기록·맥락부재만 여기서 종결하고, 나머지는 LLM 판정으로 보낸다.
 */
export function routeQuestion(
  question: string,
  glossary: GlossaryEntry[] = [],
  players: PlayerRef[] = [],
  hasContext = false,
): QuestionRoute {
  const normalized = question.normalize("NFKC").toLowerCase();
  const tokens = questionTokens(normalized);
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(normalized))) return "blocked";
  const injectionNorm = injectionNormalize(normalized);
  if (INJECTION_COMPACT_PATTERNS.some((pattern) => pattern.test(injectionNorm))) return "blocked";
  if (hasRoleChangeInjection(tokens)) return "blocked";
  // 단독 감사·확인 인사는 질문이 아니라 직전 답변에 대한 대화 행위다 — 차단 문구 대신 짧게 받는다.
  // 폐쇄집합 full-string 완전일치라 `고마워 근데 날씨 알려줘`처럼 새 요청이 붙으면 여기 걸리지
  // 않고 아래 기존 판정(비야구면 LLM NOT_BASEBALL → blocked)으로 그대로 내려간다.
  // 단독 인사말(`안녕`)도 같은 자리에서 같은 이유로 받는다 — 질문이 아니라 대화 시작이다.
  if (isAckPhrase(question) || isGreetingPhrase(question)) return "ack";
  // 범위 되묻기(`야구 룰`·`뭐 물어볼 수 있어`)는 질문이 아니라 **우리 안내문에 대한 반응**이다.
  // 외부 조회 없이 결정론으로 닫는다 — `ack` 과 같은 자리에 두는 이유도 같다(둘 다 대화 행위).
  // ⚠️ `ack` 보다 뒤에 둔다 — 두 집합은 서로 섞이지 않지만, 섞이게 되더라도
  // 감사 인사가 범위 안내문을 받는 쪽보다 그 반대가 덜 이상하다.
  if (isScopeAskPhrase(question)) return "scope_guide";
  if (SERVICE_WORDS.some((word) => normalized.includes(word))) return "service_redirect";
  const hasStat = STAT_WORDS.some((word) => tokenMatches(tokens, word));
  const hasTeam = mentionsTeam(tokens);
  // ── 기록 질문의 종착지 (2026-08-04 하린아빠 18:26 + 삼순 #1100 1차 P0-1) ──────────
  //
  // ⚠️ 여기는 **선수 기록 중 지원 지표 밖**일 때만 `history_hold` 로 끝낸다.
  //
  // 답할 수 있는 지표(타율·방어율…)는 `answerQuestion` 앞단 `kbo_structured` 가 이미
  // 가로채고, 서술형은 선수 RAG 가 가로챈다. 즉 여기까지 오는 선수 기록 질문은
  // `도루`·`출루율`·`OPS` 처럼 **운영 DB 에 컬럼 자체가 없는** 지표다(실측 근거는
  // `HISTORY_HOLD_ANSWER` 주석). LLM 에 넘기면 숫자를 지어내므로 넘기지 않는다.
  //
  // 반대로 **구단** 질문(`LG트윈스의 역사`·`삼성 주장`·`LG는 왜 못해?`)과 구단 인물
  // 질문(`감독 누구야`)은 **더 이상 여기서 종결하지 않는다**. 구단은 하린아빠가
  // 확정한 답변 범위(야구룰·구단·선수·기록) 안이므로 `history_hold`("못 답해요")나
  // `blocked`("룰/용어만 답해요")로 끝내면 둘 다 틀린 안내다. 그대로 아래로 흘려
  // LLM 2차 가드가 범위를 판정하고 답변을 생성하게 한다.
  //
  // ⚠️ 단, **수치 지표가 붙은 구단 질문**(`LG 팀타율`·`두산베어스 홈런 몇 개`)은 예외다.
  // 구단 자체는 답변 범위 안이지만 팀 단위 집계 정본이 없어 generic LLM 이 숫자를
  // 지어낸다(삼순 #1100 2차 P0-2). 선수 미지원 지표와 동일하게 fail-close 하되
  // 안내문은 `TEAM_STAT_HOLD_ANSWER` 로 갈라진다(아래 `resolveHoldAnswer`).
  //
  // 반대로 `삼성 주장`·`LG트윈스의 역사` 처럼 수치가 없는 구단 질문은 그대로
  // 흘려보낸다 — 서술은 프롬프트 범위 안이고 숫자 환각 리스크가 없다.
  if (hasStat && hasPlayerReference(tokens, players) && !hasTeam) return "history_hold";
  // ⚠️ 구단 수치는 더 이상 `history_hold`(고정 안내문)로 닫지 않는다.
  // 우리가 이미 서빙하는 값을 봇만 "못 답한다"고 하면 유저에겐 거짓말이다.
  // `team_record` 는 종결 라우트가 아니라 **조회 위임**이다 — `answerQuestion` 이
  // 실제 순위표/팀기록을 조회해 답하고, 조회 실패·미지원 지표만 fail-close 한다.
  if (hasTeam && isTeamNumericQuestion(normalized, tokens, hasStat)) return "team_record";

  const supportedRuleTerm = isSupportedRuleTermQuestion(question, glossary, players);
  if (!supportedRuleTerm) {
    // 기록/역사 어휘(통산·성적·시즌…)가 붙은 선수·수치 질문도 같은 이유로 지원 밖이다.
    // 로스터에 없는 이름(`홍길동 통산 타율`)도 수치를 지어낼 수 있으므로 같은 칸이다.
    //
    // ⚠️ 단, **구단이 지명되면 이 분기에 들어오지 않는다**(`!hasTeam`). 구단 질문은
    // 답변 범위 안이라 LLM 2차 가드가 답해야 하며, 근거 없는 수치를 말하지 않는 것은
    // 프롬프트 계약이 다룬다(삼순 #1100 1차 P0-1).
    if (
      !hasTeam &&
      (hasPlayerReference(tokens, players) || hasStat) &&
      HISTORY_CONTEXT_WORDS.some((word) => normalized.includes(word))
    ) {
      return "history_hold";
    }
  }

  // 후속 문법(폐쇄집합 full-string 일치) + 새 야구 엔티티/주제 신호 부재일 때만 직전 토픽 연장.
  // 소스 turn이 없으면 차단이 아니라 되묻기로 종료한다 (spec §4.1 B4, §4.3 AC2·AC3·AC4).
  if (isFollowupPhrase(question)) return hasContext ? "baseball_rule_term" : "context_missing";
  // ⚠️ 비교형 후속(`만루홈런이랑 비슷한 거야?`)을 룰 문법으로 판정하지 않는다.
  //   R1~R4 네 라운드 동안 계수기→typed span→typed operand 로 문법을 키웠지만 열린
  //   한국어 입력은 룰로 닫히지 않았다(하린아빠 2026-08-10 00:53 방향 확정 — 룰 최소화,
  //   LLM 위임). 직전 턴은 항상 로드해 LLM 프롬프트에 주고, 관련성 판단은 모델이 한다.
  if (supportedRuleTerm) return "baseball_rule_term";

  // ⚠️ 선수·구단을 지명했다는 이유만으로 차단하지 않는다. tier2 선수 RAG가 확장된 뒤로
  // `문보경 별명이 뭐야?` 같은 서술형 선수 질문은 근거로 답해야 하는 대상이다
  // (하린아빠 2026-08-03: "RAG을 확장했기 때문에 '문보경 별명이 뭐야?'도 답변 되어야 해").
  // 선수 경로는 answerQuestion 앞단의 resolveRagPlayerCandidate가 먼저 가로채 RAG로 보낸다.

  // 기존 범위밖 의도 denylist는 그대로 유지한다. 이건 신호어 사전처럼 "야구 어휘를 전부
  // 열거해야 하는" 종류가 아니라 범위밖임이 문장 의도로 드러난 고정밀 패턴이라 발산하지
  // 않는다(별명·누구·비교·역대·추천·날씨 등). 이걸까지 LLM에 묻면 토큰만 더 쓴다.
  if (isOutOfScopeIntent(normalized, hasTeam)) return "blocked";

  // ── `<X> <지표>` 3분기 (삼순 2026-08-08) ────────────────────────────────────
  //
  // 구단이 지명된 경우는 이미 위에서 `team_record` 로 위임됐으므로 여기 오지 않는다.
  // 남은 것은 선수/용어/모호형이다. `classifyNamedStat` 주석에 근거가 있다.
  if (!hasTeam) {
    const namedStat = classifyNamedStat(normalized, glossary, players, hasTeam);
    // DB 결속 엔티티 + 수치 의도 → 기록 경로. 지원 지표는 앞단 `kbo_structured` 가 이미
    // 가로챘으므로 여기까지 온 것은 운영 DB 에 컬럼이 없는 지표다.
    if (namedStat === "entity_stat") return "history_hold";
    // bare 모호형 → 되묻는다. `이대호 홈런` 처럼 DB 에도 없고 용어도 아닌 문장은
    // LLM 으로 내려보내지 않는다 — 존재하지 않는 기록을 지어내는 유일한 경로가 여기다.
    if (namedStat === "ambiguous") return "stat_clarify";
    // `term_question` 은 아래로 흘려 용어 질문으로 처리한다.
  }

  // ── 미결속 실명 fail-close (2026-08-08 하린아빠 제보) ───────────────────────
  //
  // 여기를 넘어가면 `llm_scope_gate` → generic LLM 이다. 그 경로는 **근거를 안 본다** —
  // 모델 기억으로 답한다. 실명이 거기 들어가면 존재하지 않는 사람을 실존으로 만들고
  // 소속·위상까지 붙인다(Production 실측: `임창규` → "LG 트윈스의 주축 선수").
  //
  // ⚠️ 순서가 계약이다. **결속된 선수는 이미 위에서 전부 빠졌다**(`history_hold`·
  //   `hasPlayerReference` 분기 · 그리고 `answerQuestion` 앞단의 선수 RAG·기록 경로).
  //   즉 여기 오는 이름은 정의상 로스터에 없다.
  if (resolveUnboundName(question, players) !== null) return "name_suggest";

  // ── 2차 가드 위임 (하린아빠 2026-08-03 지시) ─────────────────────────────────
  // 여기까지 온 질문은 "결정론적으로 야구가 아니라고 확정된" 게 아니라 **룰베이스 신호어
  // 사전이 못 가린** 질문이다. 이걸 blocked로 종결하면 사전이 야구 어휘 전체를 커버해야만
  // 정상 질문이 안 막히고, 커버리지를 넓히면 `아웃도어`⊃`아웃` 같은 누수가 다시 생긴다.
  // 사전으로는 수렴하지 않는 싸움이므로 판정을 LLM에 넘긴다.
  //
  // 단, 과거처럼 그냥 열어주는(main의 `baseball_rule_term` 폴백) 것도 아니다. 그건 비야구
  // 질문을 공식 RAG에 태워 무관한 KBO 조문이 근거로 붙게 만들었다(삼순 R1). 이 라벨은
  // **RAG/tier1 경계 밖**에서 LLM 범위판정만 받는 별도 경로다 — 아래 answerQuestion 참조.
  if (MUTATE_SCOPE_GATE === "blocked") return "blocked";
  if (MUTATE_SCOPE_GATE === "open") return "baseball_rule_term";
  return "llm_scope_gate";
}

/**
 * "야구 얘기는 그만" 류 **주제 이탈 선언**.
 *
 * 삼순 R2 재현: `야구 말고 오늘 날씨 알려줘` / `야구는 됐고 주식 추천해줘` /
 * `야구 얘기 그만하고 시를 써줘` 는 `야구` 토큰 하나 때문에 양성 신호로 잡혀
 * NOT_BASEBALL classifier 보다 먼저 공식 RAG 를 태웠고, 무관한 KBO 조문이
 * 근거로 붙은 답이 서빙됐다. 이런 문장은 야구 질문이 아니라 **야구를 배제하는** 문장이다.
 */
const TOPIC_DISMISSAL_PATTERNS: RegExp[] = [
  /야구\s*(?:얘기|이야기|말|건)?\s*말고/,
  /야구\s*(?:얘기|이야기)?\s*(?:는|은)?\s*(?:됐|관뒀|집어치)/,
  /야구\s*(?:얘기|이야기)?\s*그만/,
  /야구\s*(?:얘기|이야기)?\s*(?:는|은)?\s*(?:빼고|제외하고|아니고|아니라)/,
];

export function isTopicDismissal(question: string): boolean {
  const normalized = question.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  return TOPIC_DISMISSAL_PATTERNS.some((re) => re.test(normalized));
}

function dismissesDetectedBaseballTerm(question: string, terms: readonly string[]): boolean {
  const normalized = question.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  return terms.some((term) => {
    const anchor = term.normalize("NFKC").toLowerCase().trim();
    if (anchor.length < 2 || !normalized.includes(anchor)) return false;
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `${escaped}\\s*(?:얘기|이야기|말|건)?\\s*(?:은|는)?\\s*` +
      `(?:말고|됐고|됐으니|그만|빼고|제외하고|아니고|아니라)`,
    ).test(normalized);
  });
}

export interface ValidatedLlmAnswer {
  kind: "answer" | "blocked" | "unsure";
  answer?: string;
}

/**
 * durable `llm_text` 슬롯에 **최종 응답 envelope** 를 결속해 저장한다 (삼순 2026-08-10 P0).
 *
 * 왜: 슬롯 하나를 RAG/generic 이 공용하는데 재처리는 현재 evidence 로 경로를 다시 고른다.
 * `0건→generic 저장→retry 때 근거 생성` 이면 RAG validator 가 `ANSWER` 를 insufficient 로,
 * 반대면 generic validator 가 `GROUNDED` 를 unsure 로 접어 **정상 저장 답이 바뀐다**.
 * 그래서 raw 공급자 텍스트가 아니라 검증·조립까지 끝난 최종 응답(answer/source/sourceUrl)을
 * 저장하고, 재처리는 경로 무관하게 그대로 재생한다 — 공급자 재호출 0 · 답 동일.
 * 저장 시점은 검증 직후다(순수 CPU 구간) — 호출~저장 사이 crash 는 종전과 동일하게
 * started fence 가 ambiguous 로 fail-close 한다(재호출 없음).
 */
const STORED_QA_FINAL_MARKER = "__qa_final_v1";
export interface StoredQaFinal {
  answer: string;
  source: MatchPath;
  sourceUrl?: string;
  /** 원시점 캐시 가능 여부 (generic llm 만 true 가능). 재시도 시점 재계산 금지 —
   * context/scope/roster 를 다시 계산하면 비캐시 답이 global cache 로 샌다 (삼순 2차). */
  cacheable?: boolean;
}
export function packStoredQaFinal(final: StoredQaFinal, llm: LlmResult): LlmResult {
  return {
    text: JSON.stringify({ [STORED_QA_FINAL_MARKER]: true, final }),
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
  };
}
export function unpackStoredQaFinal(text: string): StoredQaFinal | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || row[STORED_QA_FINAL_MARKER] !== true) return null;
  const final = row.final as Record<string, unknown> | undefined;
  if (!final || typeof final.answer !== "string" || typeof final.source !== "string") return null;
  return {
    answer: final.answer,
    source: final.source as MatchPath,
    ...(typeof final.sourceUrl === "string" ? { sourceUrl: final.sourceUrl } : {}),
    ...(typeof final.cacheable === "boolean" ? { cacheable: final.cacheable } : {}),
  };
}

/**
 * 저장된 최종 응답 envelope 재생 — **front 와 5개 LLM 경계가 공용**한다 (삼순 2026-08-10
 * 3차 TOCTOU). front 가 `result=null` 을 읽은 뒤 다른 worker 가 envelope 를 저장하면,
 * 이 worker 의 경계 재조회가 envelope 를 raw 공급자 응답으로 검증해 정상 final 을
 * `unsure` 로 재저장·덮어쓰기 했다. 경계도 같은 helper 로 envelope 를 반드시 인식한다.
 */
async function replayStoredFinalResult(
  llm: LlmResult | null,
  args: { userId: string; question: string; questionNorm: string; remaining: number; deps: QaDeps },
): Promise<QaResult | null> {
  if (!llm) return null;
  const storedFinal = unpackStoredQaFinal(llm.text);
  if (!storedFinal) return null;
  const { userId, question, questionNorm, remaining, deps } = args;
  // crash 복구 완결 — **원시점 cacheable** 일 때만 캐시를 마저 쓴다 (재시도 시점
  // context/scope/roster 재계산 금지 — 비캐시 답이 global cache 로 샌다).
  if (storedFinal.source === "llm" && storedFinal.cacheable === true) {
    await deps.setCache(questionNorm, storedFinal.answer);
  }
  await deps.log({
    userId, question, questionNorm, matchPath: storedFinal.source,
    answer: storedFinal.answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens,
  });
  return {
    status: 200, answer: storedFinal.answer, source: storedFinal.source, remaining,
    ...(storedFinal.sourceUrl ? { sourceUrl: storedFinal.sourceUrl } : {}),
  };
}

/**
 * 선종결을 durable LLM state 에 **원자 CAS 로 결속**해 발송한다 (삼순 2026-08-10 5차).
 *
 * 재조회는 fence 가 아니다 — 2차 조회가 null 인 직후 다른 worker 가 acquire·저장을 하면
 * 여전히 두 답이 갈린다. 그래서 LLM 경계에 닿기 전에 종결하는 경로(검색 throw ·
 * news 0건/throw · global cache hit)도 **같은 CAS(acquireLlmStart)** 를 통과한다:
 *   · 저장 envelope 있음 → 그대로 재생 (재저장 0)
 *   · legacy raw 있음 → 다른 worker 가 공급자를 이미 소비 — 물러남(pending), 재시도가
 *     경계에서 그 raw 를 최종화한다
 *   · started && !result → winner 진행 중이면 pending, fence 경과면 error (경계와 동일)
 *   · 미시작 → CAS 를 건다. **이기면** envelope 를 먼저 저장하고 발송한다 — 이후 어떤
 *     worker 도 CAS 를 이길 수 없으므로 경합 답이 생길 수 없다. **지면** pending —
 *     winner 의 final 이 재시도에서 재생된다.
 * 상태 조회/CAS 실패는 pending — 저장 여부를 모르는 채 다른 답을 발송하지 않는다.
 */
async function settleThroughDurableBoundary(
  final: StoredQaFinal,
  logAnswer: string | null,
  args: { userId: string; question: string; questionNorm: string; remaining: number; deps: QaDeps },
): Promise<QaResult> {
  const { userId, question, questionNorm, remaining, deps } = args;
  const pending: QaResult = { status: 202, answer: "", source: "pending", remaining };
  const send = async (): Promise<QaResult> => {
    await deps.log({
      userId, question, questionNorm, matchPath: final.source,
      answer: logAnswer, inputTokens: null, outputTokens: null,
    });
    return {
      status: 200, answer: final.answer, source: final.source, remaining,
      ...(final.sourceUrl ? { sourceUrl: final.sourceUrl } : {}),
    };
  };
  // durable 배선이 없는 환경(단위 하니스 등)은 경합 자체가 없다 — 그대로 발송.
  if (!deps.getLlmState || !deps.acquireLlmStart) return send();
  let state: { started: boolean; result: LlmResult | null; ownerActive?: boolean };
  try {
    state = await deps.getLlmState();
  } catch {
    return pending;
  }
  const replayed = await replayStoredFinalResult(state.result, args);
  if (replayed) return replayed;
  if (state.result) return pending;
  if (state.started) {
    if (state.ownerActive) return pending;
    await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
    return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining };
  }
  let won = false;
  try {
    won = await deps.acquireLlmStart();
  } catch {
    return pending;
  }
  if (!won) return pending;
  if (deps.storeLlm) {
    await deps.storeLlm(packStoredQaFinal(final, { text: "", inputTokens: null, outputTokens: null }));
  }
  return send();
}

/** JSON 스키마·센티널·출력 안전성 검증을 모두 통과한 답만 캐시 가능하다. */
export function validateLlmResponse(raw: string, question = ""): ValidatedLlmAnswer {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return { kind: "unsure" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unsure" };
  const row = value as Record<string, unknown>;
  const status = String(row.status);
  // 계약 밖 status는 판정 불명확 → 답변이 아니라 되묻기로 fail-closed 한다.
  if (
    ![RULE_TERM_SENTINEL, LEGACY_ANSWER_SENTINEL, NOT_BASEBALL_SENTINEL, UNSURE_SENTINEL]
      .includes(status)
  ) {
    return { kind: "unsure" };
  }
  if (status === NOT_BASEBALL_SENTINEL) return { kind: "blocked" };
  if (status === UNSURE_SENTINEL) return { kind: "unsure" };
  if (typeof row.answer !== "string") return { kind: "unsure" };
  const answer = row.answer.trim();
  if (
    answer.length === 0 ||
    answer.length > BASEBALL_GENIUS_MAX_ANSWER_LENGTH ||
    /https?:\/\/|www\.|(?:^|\s)\[[^\]]+\]\([^)]+\)|```|<a\b/i.test(answer) ||
    // ⚠️ 답변 문자열만 보지 않고 **원질문 맥락**과 함께 판정한다(삼순 4차 P0-1).
    !answerInQuestionScope(question, answer)
  ) {
    return { kind: "unsure" };
  }
  return { kind: "answer", answer };
}

/** 사전에서 정규화 exact 매칭 (term/alias 각각 key·question 두 정규화 레벨로 인덱싱) */
/** LLM 재서술 호출에 함께 넘기는 부가 맥락 — 직전 턴 + 현재 로스터 블록 (축 A·D). */
export interface RagLlmExtras {
  context?: ContextTurn;
  rosterBlock?: string;
}

/**
 * roster 필드(팀·포지션·등번호)로 **완전히 검증 가능한** 질문인가 (삼순 2026-08-10 P0-2).
 *
 * 근거 0건 로스터 선수의 generic LLM 양보는 이 질문들로만 좁힌다 — 별명·학교·데뷔 같은
 * 서술은 roster 로 검증할 수 없어 모델 기억 생성(환각 통로)이 되므로 fail-close 유지.
 * 판정 입력은 roster 컬럼명이라는 **닫힌 집합**이라 룰이 맞다(열린 의도 분류가 아니다).
 */
export function rosterMembershipBlock(
  question: string,
  context: ContextTurn | null,
  players: PlayerRef[],
): string | null {
  // ⚠️ **질문에 등장한 선수가 항상 먼저다** (2026-08-10 E2E 실측 결함).
  //   직전 턴 답변이 구단 명단(선수 10명+)이면 상한이 그 이름들로 차서 정작 질문의
  //   선수(최형우) 줄이 탈락했고, 모델은 남은 KIA 줄들에 끌려 "KIA 소속, 삼성 아님"
  //   으로 **역정정**했다. 현재 질문 매치 → 직전 턴 매치 순으로 넣고 상한도 분리한다.
  const questionHay = question.normalize("NFKC").toLowerCase();
  const contextHay = [context?.question ?? "", context?.answer ?? ""]
    .join("\n").normalize("NFKC").toLowerCase();
  const fromQuestion: string[] = [];
  const fromContext: string[] = [];
  const seen = new Set<string>();
  for (const player of players) {
    const name = (player.name ?? "").normalize("NFKC").toLowerCase();
    if (name.length < 2 || !player.team) continue;
    const inQuestion = questionHay.includes(name);
    const inContext = !inQuestion && contextHay.includes(name);
    if (!inQuestion && !inContext) continue;
    const key = `${player.name}:${player.team}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 동명이인은 두 줄 다 넣는다 — 어느 쪽인지 확정하는 건 룰이 아니라 모델·유저 맥락이다.
    // 포지션·등번호도 함께 싣는다 — 양보 대상 질문(소속·포지션·등번호)의 데이터가 블록에
    // 없으면 모델 기억 생성이 된다 (삼순 blocker ②).
    const detail = [
      `${player.name}: ${player.team} 소속`,
      player.position ? `포지션 ${player.position}` : null,
      player.backNo ? `등번호 ${player.backNo}번` : null,
    ].filter(Boolean).join(", ");
    (inQuestion ? fromQuestion : fromContext).push(detail);
  }
  const lines = [...fromQuestion.slice(0, 8), ...fromContext.slice(0, 8)];
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * 해당 구단의 현재 로스터 명단 블록 — 구단 RAG(스냅샷 문서) 답변이 "현재 선수단"을
 * 물었을 때 과거 명단을 옮기지 않도록 정본 명단을 함께 준다 (축 D).
 */
/**
 * 당일 1군 등록 명단 블록 (`roster_snapshots` SSOT). 날짜 provenance 를 함께 싣는다 —
 * 스냅샷이 하루 이상 묵을 수 있으므로(우천·폭염 취소) 기준일을 모델·유저 모두 알아야 한다.
 */
/**
 * **1군 명단 질문**인가 — 단일 구단 + 엔트리 어휘(닫힌 집합). 이 질문은 RAG 재서술이
 * 아니라 `roster_snapshots` 를 **코드가 직접 렌더**해 답한다 (draft `lblDraft` 선례).
 *
 * ⚠️ 왜 직접 렌더인가 (삼순 2026-08-10 blocker ③): RAG 경로에 명단 블록을 주입해
 *   모델이 재서술하게 하면 ①답변에 나무위키 출처가 붙고(명단의 정본은 스냅샷인데)
 *   ②"1군"의 숫자 1을 위한 사면이 tier2 숫자 HOLD 를 무르게 만든다. 정본 데이터를
 *   그대로 보여주는 질문에 생성 모델을 태울 이유가 없다.
 */
export function isTeamEntryQuestion(question: string): boolean {
  // ⚠️ 판정 방식 (삼순 2026-08-10 2차 협착): 단어 **존재**로 열린 의도를 판정하지 않는다 —
  //   `기아 1군은 왜 못해?` 는 1군이 들어 있어도 명단 요청이 아니다. 제외어 열거도
  //   금지(발산). 대신 **명시적 명단 요청 full-string 문법**으로 닫는다: 구단 언급을
  //   지운 잔여 문장이 `1군 핵심어 + (명단 명사|요청 꼬리)` 로만 분해될 때만 참이다.
  //   `선수단`·`로스터` 단독은 어휘에서 뺐다 — 전체 선수단(등록 91명)이지 1군 엔트리가
  //   아니라서, 그 질문에 1군 명단을 주면 그 자체가 오답이다(삼순 지적).
  const compact = question.normalize("NFKC").toLowerCase().replace(/[\s?!.~,]+/g, "");
  // 구단 언급 제거 — 판정 대상은 "무엇을 요청했나" 뿐이다.
  let rest = compact;
  for (const { canonical, shorts, nicks } of TEAM_ALIASES) {
    for (const word of [canonical.toLowerCase(), ...shorts, ...nicks]) {
      rest = rest.split(word).join("");
    }
  }
  // 닫힌 문법: (시점어)? + 1군 핵심 + (등록)? + (명단 명사 | 선수 (명단)?)? + (조사)? + (요청 꼬리)?
  // 전부 선택적이지만 **full-string** 이므로 다른 서술(왜 못해·부상·운영 등)이 붙으면 탈락.
  return /^(오늘|당일|현재|지금)?(의)?(1군|일군)(등록)?(엔트리|명단|선수들?(명단)?)?(은|는|이|가|좀|을|를)?(누구(야|예요|인가요)?|누가있(어|나요)?요?|알려줘|알려주세요|보여줘|보여주세요|뭐야|어떻게(돼|되나요))?$/.test(rest)
    && /(1군|일군)/.test(rest);
}

/**
 * 1군 명단 **답변 문구** 렌더 — 블록(프롬프트용)과 별개로 entry 에서 직접 조립한다.
 * ⚠️ 종전에는 블록 문자열을 replace 로 수술했는데 `기준 기준)` 이중 표기가 실측됐다
 *   (삼순 반례). 문자열 수술 금지 — 최종 문구는 exact 단위 테스트로 잠근다.
 */
export function renderTeamEntryAnswer(
  teamCanonical: string,
  entry: { snapshotDate: string; players: string[] },
): string {
  return `${teamCanonical} 1군 등록 명단이에요 (KBO 공식 당일 등록, ${entry.snapshotDate} 기준):\n${entry.players.join(", ")}`;
}

export const TEAM_ENTRY_UNAVAILABLE_ANSWER =
  "지금은 당일 1군 등록 명단을 확인할 수 없어요. 잠시 후 다시 물어봐 주세요.";

/**
 * 1군 명단 스냅샷 신선도 상한 (일). 우천·폭염 취소로 며칠 비는 것은 정상이지만,
 * 그 이상 묵은 스냅샷을 "당일 등록" 으로 내보내면 기준일 표기가 있어도 오답에 가깝다 —
 * stale 이면 명단 자체를 버리고 전체 등록 명단 + "1군 구분 불가" 고지로 fail-close 한다.
 */
export const TEAM_ENTRY_MAX_AGE_DAYS = 7;

export function teamEntryBlock(
  candidate: RagTeamCandidate,
  entry: { snapshotDate: string; players: string[] } | null,
  now: Date = new Date(),
): string | null {
  if (!entry) return null;
  // 완전성 — 1군 엔트리는 구조적으로 20~40명이다. 그 밖이면 크롤 부분 실패로 보고
  // 명단을 버린다(반쪽 명단을 "당일 등록"으로 내보내는 쪽이 더 위험하다). (삼순 blocker ①)
  if (entry.players.length < 20 || entry.players.length > 40) return null;
  // freshness — 파싱 불가·미래 날짜도 fail-close.
  const snapshotMs = Date.parse(`${entry.snapshotDate}T00:00:00+09:00`);
  if (!Number.isFinite(snapshotMs)) return null;
  const ageDays = (now.getTime() - snapshotMs) / 86_400_000;
  // 미래 경계 (삼순 반례): `-1` 완충을 두면 **내일 날짜**가 통과한다. 미래는 전부 무효 —
  // KST 자정 기준이라 당일 스냅샷은 항상 ageDays ≥ 0 이다.
  if (ageDays > TEAM_ENTRY_MAX_AGE_DAYS || ageDays < 0) return null;
  return `${candidate.name} 1군 등록 명단 (KBO 공식 당일 등록, ${entry.snapshotDate} 기준): ${entry.players.join(", ")}`;
}

export function teamRosterBlock(candidate: RagTeamCandidate, players: PlayerRef[]): string | null {
  const canonical = candidate.name;
  const entry = TEAM_ALIASES.find((team) => team.canonical === canonical);
  if (!entry) return null;
  // 로스터 team 필드는 약칭(`LG`·`KIA`…)이다 — canonical/약칭 어느 쪽과도 맞춘다.
  const accepted = new Set([canonical, ...entry.shorts].map((word) => word.normalize("NFKC").toLowerCase()));
  const names = players
    .filter((player) => accepted.has((player.team ?? "").normalize("NFKC").toLowerCase()))
    .map((player) => player.name);
  if (names.length === 0) return null;
  // ⚠️ provenance (삼순 2026-08-10 SSOT 정정): players-roster 는 **현재 소속** SSOT 이지
  //   "1군 당일 등록 명단" SSOT 가 아니다. 1군 엔트리 데이터는 미보유이므로 라벨로
  //   구분 불가를 명시하고, 프롬프트가 1군 질문에 fail-close(기준 밝히기)로 답하게 한다.
  return `${canonical} 현재 등록 선수 (KBO 공식 로스터 기준 — 1군·2군 당일 등록 여부는 포함하지 않음): ${names.join(", ")}`;
}

export function matchGlossary(entries: GlossaryEntry[], question: string): GlossaryEntry | null {
  const index = new Map<string, GlossaryEntry>();
  for (const entry of entries) {
    for (const name of [entry.term, ...entry.aliases]) {
      index.set(normalizeKey(name), entry);
      index.set(normalizeQuestion(name), entry);
    }
  }
  return index.get(normalizeKey(question)) ?? index.get(normalizeQuestion(question)) ?? null;
}

/**
 * 선수 서술형 질문의 **종단 경로**. 이 함수에 들어오면 어떤 경우에도 아래 일반 LLM·글로벌
 * 캐시 경로로 내려가지 않는다 (삼순 R1 P0 #4).
 *
 * 왜인가: 근거 0건·근거부족·오염근거일 때 기존 경로로 통과시키면, "문보경 별명" 같은 질문이
 * 근거 없는 일반 LLM 생성답으로 나가고 그 답이 global 캐시에까지 썻긴다. 실제로 공급자 응답이
 * NOT_BASEBALL이 아니면 `source=llm` + cache write가 재현된다(삼순 alternate-provider probe).
 * 따라서 이 경로는 **generic LLM 0 / cache 0**으로 명시 종결한다.
 *
 * RAG LLM 호출도 일반 LLM과 **동일한 durable 경계**(getLlmState/acquireLlmStart/storeLlm)를 통과한다
 * (삼순 R1 P0 #5). 한 messageId가 소비하는 LLM 호출은 경로와 무관하게 정확히 1회이며,
 * crash/lease 회수 뒤 재처리는 저장된 결과를 재사용하고 ambiguous 창은 fail-close 한다.
 * 경로 분기는 질문만으로 결정되므로(서술형 + 단일 entity), 재처리가 같은 경로로 돌아오는 것은
 * 결정론적이다 — 저장된 결과를 어느 검증기로 읽을지가 모호해지지 않는다.
 */
/**
 * 시즌 기록(수치) 질문을 구조화 DB 로 답한다 (kbo_structured).
 *
 * 하린아빠 2026-08-03: "기록도 레퍼런스하는거야? 가령 문보경 올해 2루타 몇개 침어?"
 *
 * 나무위키(tier2) 숫자는 정본이 아니라 그걸로 답하면 안 되고(§12 수치 계약),
 * 그렇다고 무조건 차단해도 안 된다. 그래서 운영 DB 의 최신 row 를 **원값 그대로** 낸다.
 *
 * 안전 계약 (삼순 조건 ①~④):
 *   ① 조회는 항상 **kboId exact** — 이름 조회 금지(동명이인이 섞인다)
 *   ② 올해(2026)만 — 작년·통산은 DB 에 row 가 없으므로 fail-close
 *   ③ 허용 필드는 원값 렌더 — 타율을 hits/ab 로 재계산하지 않는다
 *   ④ stale/row 0/row 2+/identity 불일치/비정상값 → 답변 금지 + 기준시각 표시
 *
 * **LLM · RAG · cache 를 전혀 쓰지 않는다.** 결정론적 조회 1회로 끝난다.
 * 반환 null 은 "이 경로 대상이 아니다" — 호출부가 서술형 RAG 로 내려보낸다.
 */
async function answerSeasonRecordQuestion(
  userId: string,
  question: string,
  questionNorm: string,
  candidate: RagPlayerCandidate,
  remaining: number,
  deps: QaDeps,
  intentOverride?: ReturnType<typeof resolveSeasonRecordIntent>,
): Promise<QaResult | null> {
  const intent = intentOverride ?? resolveSeasonRecordIntent(question);
  if (intent.kind === "none") return null;

  const settle = async (answer: string, matchPath: MatchPath, source: MatchPath): Promise<QaResult> => {
    await deps.log({ userId, question, questionNorm, matchPath, answer, inputTokens: null, outputTokens: null });
    return { status: 200, answer, source, remaining };
  };

  // 신뢰할 수 없는 지표(pa/sac/sf)·지원 안 하는 시즌은 둘 다 **답변 거절**로 명시 종결한다.
  // 조용히 서술형 RAG 로 흘리면 위키 숫자가 대신 나가버린다 — 정확히 막으려던 것이다.
  if (intent.kind === "untrusted_metric") {
    return settle(UNTRUSTED_METRIC_ANSWER, "blocked", "blocked");
  }
  if (intent.kind === "unsupported_season") {
    return settle(UNSUPPORTED_SEASON_ANSWER, "blocked", "blocked");
  }

  // ── 소스 선택 ──────────────────────────────────────────────────────────────
  // 도루·출루율·장타율·OPS 는 `player_stats_batter` 에 **컬럼이 없다**. 앱 화면이 쓰는
  // 정본은 `stats-2026-batters.json`(=`/api/stats`)이라 그쪽을 본다
  // (하린아빠 2026-08-04 20:42 "우리가 다 제공하고 있는 데이터인데").
  //
  // ⚠️ 두 소스를 섞는 이상 **한쪽만 갱신된 상태**가 위험하다. 봇이 앱과 다른 숫자를
  // 말하는 게 최악이므로, 스냅샷으로 답할 때는 DB row 와 겹치는 지표를 교차검증하고
  // 하나라도 어긋나면 답하지 않는다.
  const useServed = intent.query.table === "batter" && isServedOnlyMetric(intent.query.metric);
  if (useServed && !deps.fetchServedRecord) {
    // 주입이 없으면 이 지표는 아직 답할 수 없다 — 없는 컬럼을 DB 에서 읽어 봐야 missing 이다.
    return settle(RECORD_MISSING_ANSWER, "blocked", "blocked");
  }

  let rows: SeasonRecordRow[];
  try {
    rows = useServed
      ? await deps.fetchServedRecord!(candidate.entityId)
      : await deps.fetchSeasonRecord!(intent.query.table, candidate.entityId);
  } catch {
    // 조회 실패를 "기록 없음"으로 둔갑하지 않는다 — 재시도 가능한 실패다.
    return settle(SYSTEM_ERROR_ANSWER, "error", "error");
  }

  if (useServed) {
    // 교차검증: 같은 선수의 DB row 와 겹치는 정수 지표가 전부 일치해야 한다.
    // DB 조회가 실패하거나 행이 없으면 **확인 못 한 것**이므로 답하지 않는다.
    let dbRows: SeasonRecordRow[] = [];
    try {
      dbRows = deps.fetchSeasonRecord
        ? await deps.fetchSeasonRecord("batter", candidate.entityId)
        : [];
    } catch {
      return settle(SYSTEM_ERROR_ANSWER, "error", "error");
    }
    const cross = crossCheckServedAgainstDb(rows[0], dbRows);
    if (cross.kind !== "ok") return settle(RECORD_MISSING_ANSWER, "blocked", "blocked");
  }

  const outcome = resolveSeasonRecord(
    rows,
    intent.query,
    candidate.entityId,
    deps.now ? deps.now() : Date.now(),
    candidate.name,
    candidate.team ?? null,
  );
  if (outcome.kind === "ok") {
    const answer = composeSeasonRecordAnswer(outcome);
    return settle(answer, "kbo_structured", "kbo_structured");
  }
  // stale · missing · inconsistent — 전부 안내로 닫는다. 추정값을 내지 않는다.
  return settle(RECORD_MISSING_ANSWER, "blocked", "blocked");
}

async function answerPlayerDescriptiveQuestion(
  userId: string,
  question: string,
  questionNorm: string,
  candidate: RagPlayerCandidate,
  remaining: number,
  deps: QaDeps,
  extras: RagLlmExtras = {},
): Promise<QaResult | null> {
  const failClose = async (): Promise<QaResult> => {
    // 근거로 답할 수 없는 선수 서술형 질문. 중요한 건 문구가 아니라 **여기서 끝난다**는
    // 것이다: generic LLM 호출도 cache write도 없다.
    //
    // ⚠️ `blocked` 가 아니라 `unsure` 다 (삼순 2026-08-08 ①). 유저는 실존 선수를 정확히
    //   물었고 우리가 근거를 못 찾은 것뿐이다. `blocked` 는 "그건 우리가 다루는 주제가
    //   아니다" 라는 뜻이라, 선수 질문을 그 칸에 넣으면 감사에서 "범위 밖 질문"으로 세어진다.
    await deps.log({ userId, question, questionNorm, matchPath: "unsure", answer: UNCLEAR_ANSWER, inputTokens: null, outputTokens: null });
    return { status: 200, answer: UNCLEAR_ANSWER, source: "unsure", remaining };
  };
  const failCloseError = async (): Promise<QaResult> => {
    await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
    return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining };
  };

  // 수요 기록은 ingestion 우선순위 신호일 뿐이라 실패해도 답변 경로를 막지 않는다.
  if (deps.recordRagDemand) {
    try {
      await deps.recordRagDemand([candidate.sourceKey]);
    } catch {
      // 무시
    }
  }

  // 근거 검색은 LLM 경계 앞이다 — 근거가 없으면 LLM을 아예 소비하지 않고 종결한다.
  let evidence: RagEvidence[];
  try {
    evidence = selectEvidence(await deps.searchRag!(candidate, question));
  } catch {
    // ⚠️ 검색 RPC 실패는 "근거가 없다" 가 아니라 **우리 쪽 고장**이다 (삼순 2026-08-08 ①).
    //   둘을 같은 칸에 넣으면 장애가 "근거 부족" 통계에 섞여 조용히 정상처럼 보인다.
    // 선종결 CAS 결속 (삼순 5차): error 발송도 durable 경계를 이긴 쪽만 한다.
    return settleThroughDurableBoundary(
      { answer: SYSTEM_ERROR_ANSWER, source: "error" }, null,
      { userId, question, questionNorm, remaining, deps },
    );
  }
  // 미커버 선수(0행)·sanitize 뒤 남는 근거 없음 — **generic LLM 으로 양보한다** (null).
  //
  // ⚠️ 2026-08-10 방향 전환 (하린아빠 00:53 "LLM 기본 능력 최대 활용" + E2E 실측).
  //   종전에는 여기서 unsure 로 명시 종결했다. 그 결과 chunk 0건인 로스터 선수(실측
  //   최형우 72443 = 0행, 커버리지 54.8%의 나머지 절반)는 소속 정정("최형우는 현재 삼성
  //   소속인데??")까지 전부 "질문을 정확히 이해하지 못했어요"를 받았다. generic 경로는
  //   현재 소속 roster 블록 + 직전 턴 + 숫자 근거없음 계약을 갖고 있어 이 질문에 정확히
  //   답한다(프로브 실측). 환각 축과도 다르다 — 여기 오는 후보는 정의상 **로스터 결속**
  //   선수라 실존이 보장되고(#1135 임창규 축은 미결속 실명), 수치는 프롬프트 계약이 막는다.
  //   LLM 경계는 아직 소비 전이므로(근거 검색은 경계 앞) 양보해도 이중 과금이 없다.
  //
  // ⚠️ 양보 판정에 **입력 문법을 두지 않는다** (하린아빠 P0 2026-08-10 00:58 "룰베이스
  //   무한도돌이표 절대 금지" — 소속·포지션·등번호 어휘 열거도, full-string 분해 문법도
  //   전부 같은 도돌이표였다). 여기 오는 후보는 정의상 **로스터 결속** 선수라 실존이
  //   보장되고(#1135 임창규 축은 미결속 실명), generic 경로는 현재 소속·포지션·등번호
  //   roster 블록 + 직전 턴 + 숫자 근거없음 프롬프트 계약을 갖는다. 어떤 질문(정정·
  //   복합·서술 포함)이든 LLM 이 블록 데이터 안에서 답하고, 모르는 건 모른다고 말하는
  //   것이 unsure 상용구보다 낫다("잘못을 지적하니 모르겠다고 나오는 건 더 문제").
  if (evidence.length === 0) return null;

  // ── durable LLM 경계 (일반 LLM 경로와 동일 계약) ──────────────────────────
  let llm: LlmResult | null = null;
  if (deps.getLlmState) {
    let state: { started: boolean; result: LlmResult | null; ownerActive?: boolean };
    try {
      state = await deps.getLlmState();
    } catch {
      return failCloseError();
    }
    llm = state.result;
    // TOCTOU 방어 (삼순 3차): front 가 null 을 본 뒤 다른 worker 가 envelope 를 저장했을
    // 수 있다 — 경계도 공용 helper 로 envelope 를 반드시 인식한다(raw 재검증 금지).
    const boundaryReplayed = await replayStoredFinalResult(llm, { userId, question, questionNorm, remaining, deps });
    if (boundaryReplayed) return boundaryReplayed;
    if (!llm && state.started) {
      // winner가 아직 LLM 경계에 있을 수 있는 창 — loser는 어떤 답변도 발송하지 않는다.
      if (state.ownerActive) return { status: 202, answer: "", source: "pending", remaining };
      // fence 경과: 공급자 응답/과금이 이미 발생했을 수 있다 — 자동 재호출 없이 종결한다.
      return failCloseError();
    }
  }
  if (!llm) {
    if (deps.acquireLlmStart) {
      let won = false;
      try {
        won = await deps.acquireLlmStart();
      } catch {
        return failCloseError();
      }
      if (!won) return { status: 202, answer: "", source: "pending", remaining };
    }
    try {
      llm = await deps.callRagLlm!(question, evidence, extras);
    } catch {
      // 공급자 호출 실패도 우리 쪽 고장이다 — 근거는 이미 찾았다.
      return failCloseError();
    }
  }

  const validated = validateRagResponse(llm.text);
  if (validated.kind !== "grounded") {
    // 저장 실패는 throw 전파 — 재처리는 ambiguous 경로로 fail-close 되어 재호출이 없다.
    if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer: UNCLEAR_ANSWER, source: "unsure" }, llm));
    return failClose();
  }
  const answer = composeRagAnswer(validated.answer, evidence[0]);
  // 본문에는 표시명만 들어간다. 링크는 payload 로 실어 클라가 그 문구에 앵커를 씌운다.
  // allowlist 밖이면 null — payload 에도 링크를 싣지 않는다.
  const sourceUrl = displayProvenanceOf(evidence[0])?.url;
  if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer, source: "rag", sourceUrl }, llm));
  await deps.log({ userId, question, questionNorm, matchPath: "rag", answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
  return { status: 200, answer, source: "rag", remaining, sourceUrl };
}

/**
 * 규칙·용어 질문을 **KBO 공식 간행물(tier1) 근거**로 답한다.
 *
 * 선수 경로(`answerPlayerDescriptiveQuestion`)와 세 가지가 다르다:
 *  1. entity로 문서를 특정하지 않는다 — "보크가 뭐야"는 어느 간행물 몇 페이지에 답이 있는지
 *     질문만으로 알 수 없다. 공식 문서 전체를 벡터로 검색한다.
 *  2. 근거가 tier1이므로 **숫자를 허용**한다(단 근거에 적힌 숫자만 — `numericTokensGrounded`).
 *  3. 실패해도 **fail-close하지 않고 null을 돌려** 기존 경로(사전·캐시·일반 LLM)로 내려보낸다.
 *     이게 핵심이다: 이 경로는 기존 답변 품질을 **올리기만** 하고 기존에 답하던 질문을
 *     새로 막지 않는다. 선수 경로의 fail-close는 "근거 없으면 생성답 금지"가 목적이었지만,
 *     규칙 질문은 원래 LLM이 답하던 정상 경로라 같은 논리를 적용하면 기능이 퇴행한다.
 *
 * LLM durable 경계는 동일하다 — 한 messageId가 소비하는 LLM 호출은 경로와 무관하게 1회다.
 * 그래서 이 함수는 **LLM 경계에 들어가기 전에만** null을 돌릴 수 있다(근거 0건).
 * 경계를 지나면 그 호출을 이미 소비했으므로 아래 일반 LLM로 내려보내지 않고 여기서 종결한다.
 */
async function answerOfficialDocumentQuestion(
  userId: string,
  question: string,
  questionNorm: string,
  remaining: number,
  deps: QaDeps,
): Promise<QaResult | null> {
  let evidence: RagEvidence[];
  try {
    evidence = selectEvidence(await deps.searchOfficialRag!(question));
  } catch {
    return null; // 검색 실패는 기존 경로로 양보한다(기능 퇴행 금지).
  }
  // 근거 0건 = 공식 문서에 답이 없는 질문. LLM을 소비하기 전이므로 안전하게 기존 경로로 내려보낸다.
  if (evidence.length === 0) return null;
  // 공식 문서 경로인데 근거가 tier1이 아니면 계약 위반이다 — 숫자 허용을 쓰지 않는다.
  if (!allowsNumericAnswer(evidence)) return null;

  // ── durable LLM 경계 (선수 경로·일반 경로와 동일 계약) ───────────────────────
  const failCloseError = async (): Promise<QaResult> => {
    await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
    return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining };
  };
  let llm: LlmResult | null = null;
  if (deps.getLlmState) {
    let state: { started: boolean; result: LlmResult | null; ownerActive?: boolean };
    try {
      state = await deps.getLlmState();
    } catch {
      return failCloseError();
    }
    llm = state.result;
    // TOCTOU 방어 (삼순 3차): front 가 null 을 본 뒤 다른 worker 가 envelope 를 저장했을
    // 수 있다 — 경계도 공용 helper 로 envelope 를 반드시 인식한다(raw 재검증 금지).
    const boundaryReplayed = await replayStoredFinalResult(llm, { userId, question, questionNorm, remaining, deps });
    if (boundaryReplayed) return boundaryReplayed;
    if (!llm && state.started) {
      if (state.ownerActive) return { status: 202, answer: "", source: "pending", remaining };
      return failCloseError();
    }
  }
  if (!llm) {
    if (deps.acquireLlmStart) {
      let won = false;
      try {
        won = await deps.acquireLlmStart();
      } catch {
        return failCloseError();
      }
      if (!won) return { status: 202, answer: "", source: "pending", remaining };
    }
    try {
      llm = await deps.callOfficialRagLlm!(question, evidence);
    } catch {
      // LLM 호출 실패. 경계를 이미 소비했을 수 있어 일반 경로로 내려보내지 않는다.
      return failCloseError();
    }
  }

  const validated = validateRagResponse(llm.text, { numericEvidence: true, evidence, generalFallback: { question } });
  // GENERAL — 공식 간행물에 답이 없어 일반 야구 지식으로 답했다 (2026-08-10 unsure 함정 제거).
  //   종전에는 여기서 무조건 unsure 하드 종결이었다 — 그 결과 `지명 타자의 DH 약자`·
  //   `잔루만루`·`ph 포지션`·`wRC+ 해석` 같은 정상 질문이 전부 "이해 못함"을 받았다.
  //   이 답은 근거 없는 생성답이므로 기존 generic 경로와 같은 자격(`llm`)으로 기록하고
  //   출처는 붙이지 않는다. 숫자는 validate 단계가 질문 밖 토큰을 기계 폐기했다.
  if (validated.kind === "general") {
    if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer: validated.answer, source: "llm" }, llm));
    await deps.log({ userId, question, questionNorm, matchPath: "llm", answer: validated.answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer: validated.answer, source: "llm", remaining };
  }
  if (validated.kind !== "grounded") {
    // 공식 근거로도, 일반 지식으로도 답을 못 만들었다. LLM 호출을 이미 써서 일반 경로 재호출은 안 된다.
    if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer: UNCLEAR_ANSWER, source: "unsure" }, llm));
    await deps.log({ userId, question, questionNorm, matchPath: "unsure", answer: UNCLEAR_ANSWER, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer: UNCLEAR_ANSWER, source: "unsure", remaining };
  }
  const answer = composeRagAnswer(validated.answer, evidence[0]);
  // 본문에는 표시명만 들어간다. 링크는 payload 로 실어 클라가 그 문구에 앵커를 씌운다.
  // allowlist 밖이면 null — payload 에도 링크를 싣지 않는다.
  const sourceUrl = displayProvenanceOf(evidence[0])?.url;
  if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer, source: "rag", sourceUrl }, llm));
  await deps.log({ userId, question, questionNorm, matchPath: "rag", answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
  return { status: 200, answer, source: "rag", remaining, sourceUrl };
}

/**
 * 구단 질문을 **적재된 tier2 구단 문서 근거**로 답한다.
 *
 * 왜 필요한가 (2026-08-05 production 실측):
 *   `genius_rag_serving_chunks` 에 `entity_type='team'` chunk 가 **71,531건** 적재돼 있는데
 *   `LG 트윈스 역사 알려줘` 가 `source=llm` 로 나갔다. 즉 답이 맞아 보였던 것은
 *   모델이 원래 알던 것이지 우리 근거를 읽은 게 아니었다. `searchRag` 가
 *   `RagPlayerCandidate` 만 받고 team 후보를 만드는 코드가 아예 없었다(미배선).
 *
 * 경로 설계는 **공식문서 경로와 같은 양보 규칙**을 따른다(선수 경로와 다르다):
 * 근거가 없으면 **fail-close 하지 않고 null** 을 돌려 기존 경로(LLM 범위판정 또는
 * `TEAM_STAT_HOLD_ANSWER`)로 내려보낸다. 구단 서술은 지금도 LLM 이 답하는 정상 경로라
 * 선수처럼 닫아버리면 **기능이 퇴행한다**(#1100 구단 과차단 회귀).
 *
 * 수치 계약(§12)은 그대로다:
 *  - 우리가 **서빙하는** 수치(순위·승패·팀타율…)는 이 함수에 오지도 않는다 —
 *    `kbo_structured` 가 먼저 정본으로 답한다.
 *  - 서빙하지 **않는** 수치(우승 횟수 등)만 `allowNumbers=true` 로 오며,
 *    그때도 `numericTokensGrounded` 가 근거에 적힌 토큰만 통과시킨다(계산·추정 불가).
 *
 * LLM durable 경계는 동일하다 — 경계를 지나면 이미 호출을 소비했으므로 null 을 돌려
 * 기존 경로로 내려보내지 않고 여기서 종결한다.
 */
async function answerTeamRagQuestion(
  userId: string,
  question: string,
  questionNorm: string,
  candidate: RagTeamCandidate,
  remaining: number,
  deps: QaDeps,
  /**
   * 유저가 **수치를 물은** 질문인가(우리가 서빙하지 않는 값 — 우승 횟수 등).
   * 숫자 허용 여부가 아니라 **실패 시 안내문**을 가른다 — 수치 질문이면
   * "순위표에서 보세요"가 정확한 안내고, 서술형이면 일반 안내다.
   */
  numericQuestion: boolean,
  extras: RagLlmExtras = {},
): Promise<QaResult | null> {
  if (!deps.enableTeamRag || !deps.searchRag || !deps.callTeamRagLlm) return null;

  // 수요 기록은 ingestion 우선순위 신호일 뿐이라 실패해도 답변 경로를 막지 않는다.
  if (deps.recordRagDemand) {
    try {
      await deps.recordRagDemand([candidate.sourceKey]);
    } catch {
      // 무시
    }
  }

  let evidence: RagEvidence[];
  try {
    evidence = selectEvidence(await deps.searchRag(candidate, question));
  } catch {
    return null; // 검색 실패는 기존 경로로 양보한다(기능 퇴행 금지).
  }
  if (evidence.length === 0) return null;
  // 구단 문서는 tier2 다. tier1 이 이 경로로 새면 숫자 허용 계약이 어긋나므로 닫는다.
  if (allowsNumericAnswer(evidence)) return null;

  const failCloseError = async (): Promise<QaResult> => {
    // ⚠️ 시스템 오류에 `BLOCKED_ANSWER` 를 쓰지 않는다 (삼순 2026-08-08 조건 ①).
    //   유저는 구단 질문을 정확히 했는데 "저는 야구 이야기만 답해드릴 수 있어요" 를 받는다 —
    //   우리 쪽 실패를 유저 질문 탓으로 돌리는 문구다. 다시 물으면 될 수 있으므로 ②로 간다.
    await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
    return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining };
  };

  // ── durable LLM 경계 (선수·공식 경로와 동일 계약) ─────────────────────────
  let llm: LlmResult | null = null;
  if (deps.getLlmState) {
    let state: { started: boolean; result: LlmResult | null; ownerActive?: boolean };
    try {
      state = await deps.getLlmState();
    } catch {
      return failCloseError();
    }
    llm = state.result;
    // TOCTOU 방어 (삼순 3차): front 가 null 을 본 뒤 다른 worker 가 envelope 를 저장했을
    // 수 있다 — 경계도 공용 helper 로 envelope 를 반드시 인식한다(raw 재검증 금지).
    const boundaryReplayed = await replayStoredFinalResult(llm, { userId, question, questionNorm, remaining, deps });
    if (boundaryReplayed) return boundaryReplayed;
    if (!llm && state.started) {
      if (state.ownerActive) return { status: 202, answer: "", source: "pending", remaining };
      return failCloseError();
    }
  }
  if (!llm) {
    if (deps.acquireLlmStart) {
      let won = false;
      try {
        won = await deps.acquireLlmStart();
      } catch {
        return failCloseError();
      }
      if (!won) return { status: 202, answer: "", source: "pending", remaining };
    }
    try {
      llm = await deps.callTeamRagLlm(question, evidence, extras);
    } catch {
      // 경계를 이미 소비했을 수 있어 기존 경로로 내려보내지 않는다.
      return failCloseError();
    }
  }

  // ⚠️ tier2 숫자 출력 **전면 HOLD** (삼순 2026-08-07 P0-2, 3라운드 끝에 내린 결론).
  //
  // 종전에는 `numericEvidence: true` + `requireSingleSource` 로 **근거에 적힌 숫자만**
  // 허용하려 했다. 그런데 "근거에 그 숫자가 있다"는 "근거가 그렇게 진술했다"와 다르다.
  // 범위를 두 번 좁혔는데 두 번 다 반대가설이 나왔다:
  //   · chunk 단위 → 한 chunk 안의 `1990년`·`3회` 를 조합한 새 주장이 통과
  //   · 문장 단위 → `LG는 1990년 창단했고, 통산 우승은 3회다.` 한 문장이면 똑같이 통과
  // 어절 거리·서술어 페어 같은 휴리스틱을 더 얹어도 같은 유형이 또 나올 것이다 —
  // 이건 토큰 대조로 닫힐 문제가 아니라 **진술 관계 판정**이고, 결정론적으로 못 닫는다.
  //
  // 그래서 선수 tier2 와 **같은 계약**으로 되돌린다: 숫자가 섞이면 그 답은 버린다.
  // 손해는 `1990년 창단` 같은 정확한 서술도 함께 버려진다는 것이다. 그래도
  // 지어낸 관계를 출처까지 달고 내보내는 것보다 낫다. 적재물을 읽는다는 이 PR 의
  // 목적은 숫자 없이도 달성된다(`서울 연고 구단으로 MBC 청룡을 인수해 창단`).
  //
  // 재개 조건: 진술 관계를 검증할 수 있는 수단(구조화된 구단 연표 정본 등)이 생기면
  // 그때 숫자를 열면 된다. 휴리스틱으로는 다시 열지 않는다.
  const validated = validateRagResponse(llm.text, {
    maxChars: RAG_ANSWER_MAX_CHARS,
  });
  if (validated.kind !== "grounded") {
    // 근거로 답을 못 만들었다(근거 밖 숫자 포함 또는 여러 chunk 조합). 재호출 없이 종결한다.
    // 수치 질문이었으면 "순위표에서 보세요" 안내가 정확한 다음 행동이다.
    // ⚠️ 비수치 실패는 `BLOCKED_ANSWER` 가 아니다 (삼순 2026-08-08 ①). 유저는 구단을
    //   정확히 물었고 우리가 근거로 답을 못 만든 것이다 — "야구 이야기만 답할 수 있어요" 는
    //   질문을 탓하는 말이다.
    const answer = numericQuestion ? TEAM_STAT_HOLD_ANSWER : UNCLEAR_ANSWER;
    const matchPath: MatchPath = numericQuestion ? "history_hold" : "unsure";
    if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer, source: matchPath }, llm));
    await deps.log({ userId, question, questionNorm, matchPath, answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer, source: matchPath, remaining };
  }
  const answer = composeRagAnswer(validated.answer, evidence[0]);
  const sourceUrl = displayProvenanceOf(evidence[0])?.url;
  if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer, source: "team_rag", sourceUrl }, llm));
  // `team_rag` 로 기록한다 — 선수·공식 RAG 와 섞이면 구단 전수 감사가 불가능하다.
  await deps.log({ userId, question, questionNorm, matchPath: "team_rag", answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
  return { status: 200, answer, source: "team_rag", remaining, sourceUrl };
}

/**
 * 최근 기사(news_rag) 근거로 답한다.
 *
 * 구단 문서 경로와 결정적으로 다른 점 하나: **이 함수는 null 을 돌려주지 않는다.**
 *
 * 삼순 조건부 GO ② — "fresh 근거 0·검색 오류면 team_rag/generic 폴백 금지, 명시 fail-close".
 * 앞단이 이미 `이건 최신 질문이다` 라고 판정해서 여기 보냈는데, 근거가 없다고 기존 경로로
 * 흘려보내면 다음 경로(team_rag → generic LLM)가 **한 달 전 문서나 모델 기억으로** 답한다.
 * "어제 무슨 일 있었어?" 에 오래된 서술을 붙이는 건 틀린 답을 최신인 것처럼 파는 것이라,
 * 모르면 모른다고 닫는 쪽이 유일하게 안전한 형태다.
 *
 * 따라서 반환타입이 `Promise<QaResult>` 다 — 타입 자체가 "양보 경로 없음" 을 강제한다.
 */
async function answerNewsRagQuestion(
  userId: string,
  question: string,
  questionNorm: string,
  candidate: RagNewsCandidate,
  remaining: number,
  deps: QaDeps,
): Promise<QaResult> {
  const settle = async (answer: string, matchPath: MatchPath, sourceUrl?: string): Promise<QaResult> => {
    await deps.log({ userId, question, questionNorm, matchPath, answer, inputTokens: null, outputTokens: null });
    return { status: 200, answer, source: matchPath, remaining, sourceUrl };
  };

  let evidence: RagEvidence[];
  try {
    evidence = selectEvidence(await deps.searchNewsRag!(candidate, question));
  } catch {
    // 검색 실패를 "기사 없음" 으로 둔갑하지 않는다. 재시도 가능한 실패라 error 다.
    // ⚠️ 문구도 `BLOCKED_ANSWER` 가 아니라 ② 다 (삼순 2026-08-08 조건 ①) — 우리 쪽 실패에
    //   "야구 이야기만 답할 수 있어요" 를 보내면 유저 질문을 탓하는 것이 된다.
    // 선종결 CAS 결속 (삼순 5차): error 발송도 durable 경계를 이긴 쪽만 한다.
    return settleThroughDurableBoundary(
      { answer: SYSTEM_ERROR_ANSWER, source: "error" }, SYSTEM_ERROR_ANSWER,
      { userId, question, questionNorm, remaining, deps },
    );
  }
  if (evidence.length === 0) {
    // 그 창에 기사가 없다. 과거 근거로 대신 답하지 않고 여기서 닫는다(삼순 ②).
    // 선종결 CAS 결속 (삼순 5차): unsure 발송도 durable 경계를 이긴 쪽만 한다.
    return settleThroughDurableBoundary(
      { answer: NEWS_UNAVAILABLE_ANSWER, source: "unsure" }, NEWS_UNAVAILABLE_ANSWER,
      { userId, question, questionNorm, remaining, deps },
    );
  }
  // 기사는 tier2 고정이다. tier1 이 이 경로로 새면 숫자 허용 계약이 어긋나므로 닫는다.
  if (allowsNumericAnswer(evidence)) return settle(SYSTEM_ERROR_ANSWER, "error");

  // ── durable LLM 경계 (선수·공식·구단 경로와 동일 계약) ──────────────────
  let llm: LlmResult | null = null;
  if (deps.getLlmState) {
    let state: { started: boolean; result: LlmResult | null; ownerActive?: boolean };
    try {
      state = await deps.getLlmState();
    } catch {
      return settle(SYSTEM_ERROR_ANSWER, "error");
    }
    llm = state.result;
    // TOCTOU 방어 (삼순 3차): front 가 null 을 본 뒤 다른 worker 가 envelope 를 저장했을
    // 수 있다 — 경계도 공용 helper 로 envelope 를 반드시 인식한다(raw 재검증 금지).
    const boundaryReplayed = await replayStoredFinalResult(llm, { userId, question, questionNorm, remaining, deps });
    if (boundaryReplayed) return boundaryReplayed;
    if (!llm && state.started) {
      if (state.ownerActive) return { status: 202, answer: "", source: "pending", remaining };
      return settle(SYSTEM_ERROR_ANSWER, "error");
    }
  }
  if (!llm) {
    if (deps.acquireLlmStart) {
      let won = false;
      try {
        won = await deps.acquireLlmStart();
      } catch {
        return settle(SYSTEM_ERROR_ANSWER, "error");
      }
      if (!won) return { status: 202, answer: "", source: "pending", remaining };
    }
    try {
      llm = await deps.callNewsRagLlm!(question, evidence);
    } catch {
      return settle(SYSTEM_ERROR_ANSWER, "error");
    }
  }

  // 숫자는 구단 tier2 와 동일하게 전면 HOLD 다(`numericEvidence` 미지정 = 기본값 금지).
  const validated = validateRagResponse(llm.text, { maxChars: RAG_ANSWER_MAX_CHARS });
  if (validated.kind !== "grounded") {
    if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer: NEWS_UNAVAILABLE_ANSWER, source: "unsure" }, llm));
    await deps.log({
      userId, question, questionNorm, matchPath: "unsure",
      answer: NEWS_UNAVAILABLE_ANSWER, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens,
    });
    return { status: 200, answer: NEWS_UNAVAILABLE_ANSWER, source: "unsure", remaining };
  }
  const answer = composeRagAnswer(validated.answer, evidence[0]);
  const sourceUrl = displayProvenanceOf(evidence[0])?.url;
  if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer, source: "news_rag", sourceUrl }, llm));
  await deps.log({
    userId, question, questionNorm, matchPath: "news_rag",
    answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens,
  });
  return { status: 200, answer, source: "news_rag", remaining, sourceUrl };
}

export async function answerQuestion(userId: string, rawQuestion: string, deps: QaDeps): Promise<QaResult> {
  const question = rawQuestion.trim();
  const questionNorm = normalizeQuestion(question);

  // KST 일자 버킷 원자 예약. DB 오류도 fail-closed하여 LLM에 진입하지 않는다.
  let reservation: { allowed: boolean; remaining: number };
  try {
    reservation = await deps.reserveDaily(userId, DAILY_LIMIT);
  } catch {
    return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining: 0 };
  }
  if (!reservation.allowed) {
    await deps.log({ userId, question, questionNorm, matchPath: "limited", answer: null, inputTokens: null, outputTokens: null });
    return {
      status: 429,
      answer: LIMITED_ANSWER,
      source: "limited",
      remaining: 0,
    };
  }
  const remaining = reservation.remaining;

  // ⚠️ durable 슬롯의 최종 응답 envelope 는 **route/search/cache 어떤 외부 상태보다 앞**
  //   에서 1회 재생한다 (삼순 2026-08-10 P0 2차). 경계별 재생은 그 앞의 검색 throw ·
  //   news 0건 종결 · global cache 선점이 저장된 최종 답을 다시 바꿀 수 있었다
  //   (player 2623→2655 · news 2995→3016 · generic cache 3520→3538 실측 지적).
  //   조회 실패는 신규 진행으로 두고, started/ambiguous 창은 종전대로 각 경계가 다룬다.
  if (deps.getLlmState) {
    let frontState: { started: boolean; result: LlmResult | null; ownerActive?: boolean };
    try {
      frontState = await deps.getLlmState();
    } catch {
      // 조회 실패를 null 로 두면 검색·캐시가 저장 답을 다시 이길 수 있다 (삼순 3차).
      // 답변 발송 없이 물러난다 — 저장 여부를 모르는 채 진행하지 않는다(fail-close).
      return { status: 202, answer: "", source: "pending", remaining };
    }
    const frontReplayed = await replayStoredFinalResult(frontState.result, { userId, question, questionNorm, remaining, deps });
    if (frontReplayed) return frontReplayed;
    // full state 처리 (삼순 4차): started 인데 결과가 없는 창을 버리지 않는다 —
    // winner 진행 중이면 물러나고(pending), fence 경과면 재호출 없이 error 로 닫는다.
    if (!frontState.result && frontState.started) {
      if (frontState.ownerActive) return { status: 202, answer: "", source: "pending", remaining };
      await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
      return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining };
    }
  }

  const [glossary, players] = await Promise.all([deps.loadGlossary(), deps.loadPlayers()]);
  // 직전 턴은 **항상** 로드한다 (하린아빠 2026-08-10 00:53 방향 확정 — 룰 최소화, LLM 위임).
  // "이 질문이 후속인가"는 열린 자연어 판정이라 룰로 닫히지 않는다 — 관련성 판단은
  // LLM 프롬프트("무관하면 무시")가 한다. DB 1회 조회 비용은 무시 가능하고,
  // 누수 경로는 종전과 동일(selectContextTurn 이 allowlist·TTL·본인 turn 만 통과).
  // 조회 실패는 맥락 없음으로 fail-closed 한다.
  let context: ContextTurn | null = null;
  let draftContext: ContextTurn | null = null;
  // 입단 후속 재결속(#1140)은 상시 로드된 같은 row 를 쓰되 **전용 selector 로만** 자격을
  // 본다 — 글로벌 allowlist(확장판)가 통과시킨 row 라도 draft 재결속 자격(rag·
  // kbo_structured, 직전 "질문"에서 선수 재결속, 답은 공식 필드 렌더)은 별도다.
  // 둘을 섞으면 news_rag 직전 턴이 입단 후속의 확정 문장 근거가 된다(게이트 실측 RED).
  const draftFollowup = isDraftQuestion(question)
    && !mentionsAnyRosterName(question, players)
    && isDraftFollowupGrammar(question);
  if (deps.loadPreviousTurn) {
    try {
      const row = await deps.loadPreviousTurn();
      // 글로벌: LLM 프롬프트 맥락 주입용 (답변이 실린 모든 source + unsure).
      context = selectContextTurn(row);
      // 인젝션 문장은 맥락으로도 싣지 않는다 (삼순 2026-08-10 — unsure 확장의 반례 축).
      // unsure 턴이 자격을 얻으면서 "이전 지시 무시" 류가 unsure 로 떨어진 뒤 다음 턴의
      // 프롬프트에 데이터로 실릴 수 있게 됐다. 현재 질문과 같은 인젝션 판정을 재사용한다.
      if (context && routeQuestion(context.question, glossary, players, false) === "blocked") {
        context = null;
      }
      // draft 전용: 공식 필드 확정 렌더용 (더 좁은 allowlist, #1140 계약 유지).
      draftContext = draftFollowup ? selectDraftContextTurn(row) : null;
    } catch {
      context = null;
      draftContext = null;
    }
  }
  // 축 D — 질문·직전 턴이 지목한 선수의 현재 소속(로스터 SSOT)을 모든 LLM 경로에 준다.
  const rosterBlock = rosterMembershipBlock(question, context, players) ?? undefined;
  // ── `<X> <지표>` 미결속 fail-close 를 **앞단에서** 종결한다 (삼순 2026-08-08 P0) ──
  //
  // ⚠️ `routeQuestion` 안에만 두면 계약이 end-to-end 로 성립하지 않는다. 아래 선수 후보·
  //   기록 의도·구단 위임 경로가 **routeQuestion 보다 먼저** 가로채기 때문이다:
  //     `김도영 홈런과 이대호 홈런 몇개`  → 현역 김도영이 걸려 기록/`history_hold` 로 선점
  //     `LG 팀타율이랑 오타니 홈런`       → `team_record` 로 선점
  //   그러면 helper 는 `ambiguous` 라고 판정했는데 유저는 미결속 절까지 섞인 답을 받는다.
  //   "하나라도 미결속이면 되묻는다" 는 **여기서** 끝내야 실제 계약이 된다.
  //
  // ⚠️ 생성 경로 진입 전이다 — LLM·cache·RAG 어느 것도 소비하지 않는다.
  // ⚠️ **혼합형에만** 적용한다. 순수 미결속(`이대호 홈런`·`홍길동 통산 타율`)은
  //   `routeQuestion` 이 이미 안전하게 종결한다(`stat_clarify`·`history_hold` — 둘 다
  //   생성 경로에 안 내려간다). 그걸 여기서 덮으면 `history_hold` 의 정확한 안내
  //   (앱 기록 탭)가 사라진다 — 삼순 7차 P0-2 로 확정한 계약을 되돌리는 것이다.
  //   앞단이 반드시 필요한 경우는 **결속 절이 미결속 절을 태우고 가는** 문장이다.
  //
  // ⚠️ `routeQuestion` 과 **같은 정규화**를 쓴다(`NFKC` + 소문자). 다르게 정규화하면
  //   두 곳의 판정이 갈라져 "helper 는 되묻기인데 라우터는 통과" 가 되살아난다.
  const routingNormalized = question.normalize("NFKC").toLowerCase();
  const namedStatKinds = classifyNamedStatMatches(routingNormalized, glossary, players);
  // ⚠️ 결속 신호는 **두 갈래**다. 매치로 잡히는 선수·구단(`entity_stat`)과, 매치로는
  //   안 잡히지만 구단 경로가 답할 문장(`LG 팀타율이랑 오타니 홈런`)이다. 후자는 지표어가
  //   `팀타율` 이라 `<X> <지표>` 정규식에 안 걸려 `entity_stat` 가 없다 — 그래도
  //   `team_record` 가 앞단에서 답해버리므로 미결속 절이 그대로 실려 나간다.
  //   그래서 문장 단위 구단 지명도 결속 신호로 함께 본다.
  const hasBoundClause =
    namedStatKinds.includes("entity_stat") || mentionsTeamForGate(question);
  const mixedBoundAndUnbound = namedStatKinds.includes("ambiguous") && hasBoundClause;
  if (mixedBoundAndUnbound) {
    await deps.log({
      userId, question, questionNorm, matchPath: "stat_clarify",
      answer: STAT_CLARIFY_ANSWER, inputTokens: null, outputTokens: null,
    });
    return { status: 200, answer: STAT_CLARIFY_ANSWER, source: "stat_clarify", remaining };
  }
  // 선수 RAG는 후속 출시용 explicit flag가 켜진 테스트/환경에서만 현재 룰·용어 경계를 우회한다.
  // Production은 server.ts에서 false로 고정되어 선수·구단 질문이 provider/cache에 닿지 않는다.
  // 유저가 picker에서 고른 kboId가 있으면 이름 매칭을 건너뛰고 그 선수로 직행한다.
  // 이름으로 다시 풀면 또 동명이인으로 갈라져 picker가 무한 반복된다.
  const pickedCandidate = deps.enablePlayerRag && deps.pickedPlayerKboId &&
    isPickedPlayerAllowed(question, deps.pickedPlayerKboId, players)
    ? resolvePickedPlayerCandidate(deps.pickedPlayerKboId, players)
    : null;
  // 기록(수치) 질문은 서술형 게이트에 걸리므로 이름 기반 후보를 따로 붙잡는다.
  // 서술형 게이트는 "tier2 문서로 답해도 되는가" 조건이지 "어느 선수인가" 조건이 아니다.
  const recordIntent = deps.fetchSeasonRecord
    ? resolveSeasonRecordIntent(question)
    : { kind: "none" as const };

  // **picker보다 먼저** 종결한다. `김동현 통산 홈런`처럼 이름이 모호해도 2026 외 시즌은
  // 어느 선수를 골라도 답할 수 없으므로 picker를 띄우는 것 자체가 불필요하다(삼순 P0-3).
  // untrusted metric도 마찬가지 — 고른 뒤 거절하면 유저만 헛동작한다.
  if (recordIntent.kind === "unsupported_season" || recordIntent.kind === "untrusted_metric") {
    const answer = recordIntent.kind === "unsupported_season"
      ? UNSUPPORTED_SEASON_ANSWER
      : UNTRUSTED_METRIC_ANSWER;
    await deps.log({
      userId, question, questionNorm, matchPath: "blocked", answer,
      inputTokens: null, outputTokens: null,
    });
    return { status: 200, answer, source: "blocked", remaining };
  }

  // ⚠️ 입단 질문은 서술형 게이트를 통과하지 못한다 — `몇 라운드 지명이야?` 처럼 수치어가
  //   붙기 때문이다. 그 게이트는 "tier2 문서로 답해도 되는가" 조건이지 "어느 선수인가"
  //   조건이 아니다(기록 질문이 같은 이유로 이미 예외다). 공식 필드로 답하는 경로라
  //   이름만 단일하게 특정되면 충분하다.
  // 입단 후속(`입단을 언제 했냐고?`)은 **직전 턴 질문**에서 선수를 받는다.
  //   ⚠️ 직전 턴의 **답변**이 아니라 **질문**에서 푼다. 답변에는 다른 선수 이름이
  //     섞일 수 있고(비교·언급), 그러면 엉뚱한 선수의 입단 연도를 확정 문장으로 낸다.
  const draftContextCandidate = deps.enablePlayerRag && draftFollowup && draftContext
    ? resolveNamedPlayerCandidate(draftContext.question, players)
    : null;
  const enabledPlayerCandidate = pickedCandidate ?? (deps.enablePlayerRag
    ? (resolveRagPlayerCandidate(question, players) ??
      (recordIntent.kind !== "none" || isDraftQuestion(question)
        ? resolveNamedPlayerCandidate(question, players)
        : null) ??
      draftContextCandidate)
    : null);

  // 동명이인으로 선수를 특정 못 했으면 추측하지 않고 되묻는다 (하린아빠 2026-08-03).
  // ⚠️ **답변 전 단계**이므로 공식/선수 RAG·LLM·cache 어느 것도 소비하지 않는다.
  // quota도 되돌려준다 — "어느 김동현이에요?"를 물어본 것만으로 하루 한도를 깎으면
  // 동명이인 선수만 두 배를 내는 꼴이 된다. 반납은 이 분기에서만 일어난다.
  if (!enabledPlayerCandidate && deps.enablePlayerRag) {
    // 기록 질문도 picker 대상이다 — 오히려 동명이인은 서술형보다 기록을 더 잘 답한다
    // (Production 실측: 동명이인 72명 중 28명이 타자기록 보유, 위키 chunks 는 0).
    const options = resolvePlayerPickerOptions(question, players, recordIntent.kind !== "none");
    if (options) {
      if (deps.releaseDaily) {
        try {
          await deps.releaseDaily(userId);
        } catch {
          // 반납 실패는 유저가 1개 더 쓴 것일 뿐이다 — 되묻기 자체를 막지 않는다.
        }
      }
      await deps.log({
        userId, question, questionNorm, matchPath: "player_picker",
        answer: PLAYER_PICKER_ANSWER, inputTokens: null, outputTokens: null,
      });
      return {
        status: 200,
        answer: PLAYER_PICKER_ANSWER,
        source: "player_picker",
        remaining,
        pickerOptions: options,
      };
    }
  }

  const route = enabledPlayerCandidate
    ? "baseball_rule_term"
    : routeQuestion(question, glossary, players, context !== null);
  // `llm_scope_gate`는 종결 라우트가 아니라 **판정 위임**이다. 여기서 끝내지 않고 아래로 흘려보내되,
  // 공식 RAG(②-a)·선수 RAG(②) 진입 조건은 그대로라서 tier1 조문에는 닿지 못한다.
  // 결과적으로 이 라벨은 dictionary / cache / llm / blocked / unsure 중 하나로 반드시 확정되며,
  // 스스로는 로그에 기록되지 않는다 (genius_question_logs CHECK 확장 불필요).
  // 2차 가드 경로 여부. `true`면 사전·공식 RAG·선수 RAG·global cache를 전부 건너뛰고
  // LLM 범위판정만 받는다. 특히 **cache read/write를 둘 다 끔는다** — 이 경로는 질문이
  // 야구인지 아직 모르는 상태라, 과거에 쌀인 동일 정규화 키의 답을 그대로 내보내면
  // 범위 밖 답변이 검증 없이 재노출된다(삼순 R2와 동일한 오염캐시 경로).
  // ── 구단 기록 (kbo_structured — 팀 축) ────────────────────────────────────────
  //
  // ⚠️ 이 분기가 생긴 이유: 종전에는 `LG 지금 몇 위야?` 가 고정 안내문으로 닫혔다.
  // 근거는 "팀 집계 정본이 없다" 였는데 **틀렸다**(하린아빠 2026-08-04 20:42 지적,
  // production 실측 2026-08-05 01:2x): `/api/standings` 에 LG 3위 55승45패,
  // `/api/team-records` 에 LG 팀타율 .270 · 홈런 92 · 도루 65 가 이미 서빙된다.
  // 앱 순위탭·팀기록탭이 그대로 보여주는 값을 봇만 "못 답한다"고 하는 건 거짓말이다.
  //
  // 선수 기록과 **같은 계약**으로 답한다 — 조회한 원값 그대로, 계산·추정 없음,
  // 없으면 답하지 않음, LLM 미경유. 조회 실패는 static 폴백 없이 fail-close 한다.
  if (route === "team_record") {
    const settleTeam = async (answer: string, matchPath: MatchPath): Promise<QaResult> => {
      await deps.log({ userId, question, questionNorm, matchPath, answer, inputTokens: null, outputTokens: null });
      return { status: 200, answer, source: matchPath, remaining };
    };
    const intent = resolveTeamRecordIntent(question);
    const canonicalTeam = resolveMentionedTeam(question);
    // 지표를 못 잊거나(우승 횟수·상대전적 등 미서빙 값) 구단을 하나로 특정하지 못하면
    // 지어내지 않고 닫는다. `TEAM_STAT_HOLD_ANSWER` 는 "순위표에서 보세요" 안내다.
    if (intent.kind !== "query" || !canonicalTeam || !deps.fetchTeamRecord) {
      // ⚠️ 닫기 **전에** 적재된 구단 문서를 본다 (하린아빠 2026-08-05 "배선 연결").
      //
      // 여기 오는 건 우리가 서빙하지 않는 수치(`LG 우승 몇 번?`)다. 종전에는 무조건
      // "자료가 없어요"로 닫혔는데, production 실측상 적재된 구단 문서에 그 서술이
      // **있다**(삼성 원문 `통산 한국시리즈 우승 횟수는 총 8회`). 근거를 가진 채
      // 모른다고 하는 것도 유저에겐 틀린 안내다.
      //
      // 정본이 아니므로 계약을 두 겹으로 건다: 근거에 적힌 숫자 토큰만 허용
      // (`numericTokensGrounded`) + 출처 표기 강제. 계산·합산·추정은 프롬프트가 막고
      // 출력 가드가 기계적으로 재확인한다. 근거가 없으면 종전 안내문 그대로다.
      // ⚠️ 2026-08-07 (삼순 P0-2 4라운드): 여기서 team RAG 를 호출하던 것을 **제거**했다.
      //
      //   여기 오는 질문은 전부 "우리가 서빙하지 않는 **수치**"(`LG 우승 몇 번?`)다.
      //   tier2 숫자 출력이 전면 HOLD 된 이상, 이 경로가 만들 수 있는 결과는 둘뿐이다:
      //     · 숫자가 든 답 → 출력 가드가 폐기 → 결국 아래 안내문
      //     · 숫자 없는 답 → 수치 질문에 수치가 없는 답 (유저에겐 동문서답)
      //   즉 LLM 호출과 quota 만 태우고 결과는 같다. 게다가 가드에 구멍이 하나라도
      //   생기면 그 순간 수치 질문이 tier2 숫자를 달고 나가는 통로가 된다.
      //   호출 자체를 없애는 것이 유일하게 검증 가능한 형태다.
      //
      //   구단 **서술형** RAG 는 아래 llm_scope_gate 경로에 그대로 있다(#1110 목적).
      //   수치를 다시 답하려면 tier2 가 아니라 구조화 정본을 붙여야 한다.
      return settleTeam(TEAM_STAT_HOLD_ANSWER, "history_hold");
    }
    let standings: Awaited<ReturnType<TeamRecordFetchers["fetchStandings"]>>;
    let records: Awaited<ReturnType<TeamRecordFetchers["fetchTeamRecords"]>>;
    try {
      [standings, records] = await Promise.all([
        deps.fetchTeamRecord.fetchStandings(),
        deps.fetchTeamRecord.fetchTeamRecords(),
      ]);
    } catch {
      // 조회 실패를 "기록 없음"으로 둔갓하지 않는다 — 재시도 가능한 실패다.
      return settleTeam(SYSTEM_ERROR_ANSWER, "error");
    }
    const outcome = resolveTeamRecord(intent.metric, canonicalTeam, standings, records, teamIdOfCanonical);
    if (outcome.kind === "ok") {
      return settleTeam(composeTeamRecordAnswer(outcome), "kbo_structured");
    }
    return settleTeam(TEAM_STAT_HOLD_ANSWER, "history_hold");
  }

  const scopeGate = route === "llm_scope_gate";

  if (route !== "baseball_rule_term" && !scopeGate) {
    const unbound = route === "name_suggest" ? resolveUnboundName(question, players) : null;
    const answer =
      route === "service_redirect" ? SERVICE_REDIRECT_ANSWER :
      route === "history_hold" ? resolveHoldAnswer(question) :
      route === "context_missing" ? CONTEXT_MISSING_ANSWER :
      route === "ack" ? (isGreetingPhrase(question) ? GREETING_ANSWER : ACK_ANSWER) :
      route === "scope_guide" ? SCOPE_GUIDE_ANSWER :
      // 미결속 실명 → **생성 없이** 끝난다. 후보가 유일하면 그 이름을 되묻고, 아니면
      // 모른다고 말한다. 둘 다 모델이 아니라 **코드가 쓴 문장**이다.
      //
      // ⚠️ 후보를 여기서 다시 푸는 이유 — `routeQuestion` 은 라벨만 돌려주므로 문구에
      //   넣을 이름이 여기에 없다. 판정기는 **같은 함수**를 쓴다 — 둘이 갈라지면
      //   "막기로 라우팅해놓고 정작 문구는 없는" 모순이 된다. 그 경우 fail-close.
      route === "name_suggest"
        // ⚠️ 판정기와 문구 생성이 **같은 함수**를 쓴다. 둘이 갈라지면 "막기로 라우팅해놓고
        //   정작 문구가 없는" 모순이 되므로 그 경우 fail-close 한다.
        ? (unbound === null ? UNCLEAR_ANSWER : NAME_SUGGEST_ANSWER(unbound.suggestion))
        :
      route === "stat_clarify" ? STAT_CLARIFY_ANSWER :
      BLOCKED_ANSWER;
    // ⚠️ 범위 되묻기는 **자기 라벨로** 기록한다(삼순 2026-08-08 조건 ④).
    //   `ack` 으로 접으면 이 PR 이 고친 것을 사후에 셀 수가 없다 — 감사 분모가 사라진다.
    //   화면 취급(`reply_kind`)은 `ack` 과 같게 두어 마스코트·피드백 계약은 그대로다.
    // ⚠️ 미결속 이름 되묻기는 **하루 한도를 깎지 않는다**(삼순 2026-08-08 `typo quota 반환`).
    //   유저는 답을 받지 못했고 이름을 고쳐 다시 물어야 한다 — 그 재질문까지 합쳐
    //   2개를 깎으면 **오타 한 글자에 한도를 두 배로 물리는** 꼴이다.
    //   같은 이유로 `player_picker` 도 이미 반납한다 — 되묻기는 답변이 아니다.
    //   반납 실패는 유저가 1개 더 쓴 것일 뿐이라 되묻기 자체를 막지 않는다.
    let quotaRemaining = remaining;
    if (route === "name_suggest" && deps.releaseDaily) {
      try {
        await deps.releaseDaily(userId);
        quotaRemaining = Math.min(DAILY_LIMIT, remaining + 1);
      } catch {
        // 반납 실패 — 차감된 채로 둔다. 지어낸 숫자를 보여주지 않는다.
      }
    }
    await deps.log({ userId, question, questionNorm, matchPath: route, answer, inputTokens: null, outputTokens: null });
    return { status: 200, answer, source: route, remaining: quotaRemaining };
  }

  // ① 검수 사전 (토큰 0)
  const hit = scopeGate ? null : matchGlossary(glossary, question);
  if (hit) {
    await deps.log({ userId, question, questionNorm, matchPath: "dictionary", answer: hit.answer, inputTokens: null, outputTokens: null });
    return { status: 200, answer: hit.answer, source: "dictionary", term: hit.term, remaining };
  }

  // ②-a 규칙·용어 질문은 KBO 공식 간행물(tier1) 근거를 **global 캐시보다 먼저** 시도한다.
  //
  // 순서가 바뀐 이유(삼순 R2): `genius_qa_cache`에는 tier1 적재 이전에 일반 LLM이 생성해 썻은
  // 답이 수백 행 쌓여 있다. 그것들은 공식 근거가 없던 시절의 생성답이므로 **정본보다 먼저
  // 나가면 이번 작업이 무의미**해진다(오답 캐시가 tier1을 영원히 가린다).
  // 검수 사전(①)은 사람이 검수한 답이므로 여전히 앞에 둔다.
  //
  // 또 **양성 야구 신호가 있을 때만** 탄다. `routeQuestion`은 미매칭 질문을 과차단하지 않기 위해
  // `baseball_rule_term`으로 폴백하므로, 비야구 질문도 이 라벨로 내려온다. 그걸 공식 RAG에
  // 통과시키면 비야구가 blocked 대신 unsure로 바뀌고 적대적 provider에서는 무관한 KBO 조문이
  // 근거로 붙은 답이 나간다(삼순 R1 재현). 폴백 질문은 종전대로 LLM NOT_BASEBALL 분류로 보낸다.
  if (
    !scopeGate &&
    deps.searchOfficialRag &&
    deps.callOfficialRagLlm &&
    isSupportedRuleTermQuestion(question, glossary, players)
  ) {
    const official = await answerOfficialDocumentQuestion(userId, question, questionNorm, remaining, deps);
    if (official) return official;
  }

  // ── 구단 tier2 RAG (적재된 나무위키 구단 문서 근거) ───────────────────────
  //
  // ⚠️ 위치가 계약이다. 삼순 2026-08-07 P0-1(라우팅 역전) 반영 — 종전에는 이 블록이
  // **종결 라우트보다 먼저** 실행돼, 구단명이 붙었다는 이유만으로 다른 경로의 질문을
  // 전부 선점할 수 있었다:
  //   · `LG 날씨 알려줘`      → blocked 여야 하는데 team RAG 가 근거를 달고 답함
  //   · `LG 앱 로그인 오류`   → service_redirect 여야 하는데 선점
  //   · `LG 투수 보크 규칙`   → 공식 RAG(tier1 조문)여야 하는데 선점
  //   · `LG 문보경 별명`      → 선수 RAG 여야 하는데 구단 문서로 답함
  // 배선 게이트 17 PASS 는 이 반대경로를 한 번도 안 태워서 GREEN 이었다(false-green).
  //
  // 그래서 지금 위치는 **네 겹 뒤**다:
  //  ① 종결 라우트(blocked·service_redirect·history_hold·context_missing·ack) 뒤 —
  //    범위 밖·서비스 문의는 구단명이 붙어도 종전 안내가 정답이다.
  //  ② 검수 사전(①) 뒤 — 사람이 검수한 답이 항상 우선이다.
  //  ③ 룰/용어 질문(`baseball_rule_term`)은 **아예 제외** — tier1 공식 조문이 정본이고,
  //    공식 근거가 없다고 구단 문서로 대신 답하면 `LG 투수 보크 규칙`에 LG 문서가
  //    근거로 붙는다. 즉 구단 RAG 는 `llm_scope_gate`(룰로 분류되지 않은 구단 서술 축)
  //    에서만 산다.
  //  ④ 선수 후보가 **없을 때만** — 선수가 지명된 질문은 선수 경로가 소유한다.
  // 여전히 generic LLM(③) 보다는 앞이라, 적재한 71,531 chunk 는 정상적으로 읽힌다.
  //
  // 근거가 없으면 null → 기존 경로 그대로(공식문서 경로와 같은 양보 규칙).
  // ── 최근 기사 RAG (news_rag) ────────────────────────────────────
  //
  // 위치가 계약이다(삼순 조건부 GO ①). 구단 문서 RAG **바로 앞**이면서, 그 앞의 것은 전부
  // 그대로 살려둔다:
  //  · 종결 라우트(blocked·service_redirect·ack…) — `어제 LG 앱 로그인 오류` 는 여전히 service_redirect
  //  · 구단 기록(`team_record` 분기) — `어제 LG 몇 위였어?` 는 structured 가 먼저 받는다
  //  · 검수 사전(①) — 사람이 검수한 답이 항상 우선
  //  · 공식 문서(tier1) · 룰/용어(`baseball_rule_term`) — `어제 경기에서 보크가 뭐야?` 는 조문이 정본
  //  · 선수 후보 존재 — 선수가 지명된 질문은 선수 경로가 소유한다
  // 즉 기사는 "단일 구단 + 최신성 + 서술형" 이라는 좁은 교집합만 가져간다.
  //
  // ⚠️ 이 분기에 들어오면 **여기서 종결한다**(null 양보 없음). fresh 근거 0 · 검색 오류도
  //   team_rag/generic 으로 내려보내지 않고 명시 fail-close 한다(삼순 ②).
  //   `answerNewsRagQuestion` 의 반환타입이 `QaResult`(not `| null`)라 타입이 이걸 강제한다.
  // ── 1군 명단 질문 → 직접 렌더 (draft 선례 · 삼순 blocker ③ + 반례 2건) ──────
  // ① **news 보다 앞**이다 — `오늘 기아 1군 엔트리` 는 최신성 어휘 때문에 기사 경로가
  //   선점하는데, 명단의 정본은 기사가 아니라 roster_snapshots 다.
  // ② tier2 kill-switch(enableTeamRag)와 **분리**돼 있다 — 구조화 정본 조회는 RAG 가
  //   아니므로 TEAM_RAG_DISABLED=1 이어도 살아 있어야 한다. 게이트는 배선(fetchTeamEntry)
  //   존재 여부뿐이다.
  const entryQuestionCandidate =
    deps.fetchTeamEntry && !enabledPlayerCandidate && isTeamEntryQuestion(question)
      ? resolveRagTeamCandidate(question)
      : null;
  if (entryQuestionCandidate) {
    let teamEntry: { snapshotDate: string; players: string[] } | null = null;
    const entryTeamId = Number(entryQuestionCandidate.entityId);
    try {
      teamEntry = Number.isSafeInteger(entryTeamId)
        ? await deps.fetchTeamEntry!(entryTeamId)
        : null;
    } catch {
      teamEntry = null;
    }
    // 유효성(완전성·freshness·미래 차단)은 블록 판정과 같은 함수로 본다 — 둘이 갈라지면
    // "블록은 거른 명단을 답변은 내보내는" 모순이 생긴다.
    const entryValid = teamEntryBlock(
      entryQuestionCandidate, teamEntry, deps.now ? new Date(deps.now()) : new Date(),
    ) !== null;
    const answer = entryValid && teamEntry
      ? renderTeamEntryAnswer(entryQuestionCandidate.name, teamEntry)
      : TEAM_ENTRY_UNAVAILABLE_ANSWER;
    const matchPath: MatchPath = entryValid ? "kbo_structured" : "blocked";
    await deps.log({
      userId, question, questionNorm, matchPath, answer,
      inputTokens: null, outputTokens: null,
    });
    return { status: 200, answer, source: matchPath, remaining };
  }

  const newsRagCandidate =
    deps.enableNewsRag && deps.searchNewsRag && deps.callNewsRagLlm &&
    !enabledPlayerCandidate && route !== "baseball_rule_term"
      ? resolveRagNewsCandidate(question, (deps.now ?? Date.now)())
      : null;
  if (newsRagCandidate) {
    return answerNewsRagQuestion(userId, question, questionNorm, newsRagCandidate, remaining, deps);
  }

  const teamRagCandidate =
    deps.enableTeamRag && !enabledPlayerCandidate && route !== "baseball_rule_term"
      ? resolveRagTeamCandidate(question)
      : null;
  if (teamRagCandidate && isTeamRagServableQuestion(question)) {
    // 구단 서술 질문 — RAG 재서술 (원계약 그대로: 로스터 블록 미주입·숫자 전면 HOLD).
    const teamAnswer = await answerTeamRagQuestion(
      userId, question, questionNorm, teamRagCandidate, remaining, deps, false,
      { context: context ?? undefined },
    );
    if (teamAnswer) return teamAnswer;
  }

  // ② 선수 서술형 질문은 수집된 tier2 문서 근거로만 답한다 (S2b).
  // ⚠️ **global 캐시보다 앞**에 둔다 (삼순 R3/R4 P0-3). 캐시가 먼저면 과거에 저장된
  // 근거 없는 답(오염 캐시 포함)이 선수 질문의 답으로 재노출되고 RAG 경로가 통째로
  // 무시된다 — 실제로 `문보경 별명이 뭐야?` 에 preseed 캐시를 넣으면 source=cache 로
  // 재현됐다. 이 분기에 들어오면 **여기서 종결**한다: 근거가 있으면 rag 답변,
  // 근거 0건·근거부족·오염근거는 generic LLM 0 / cache 0 으로 명시 fail-close 한다.
  const playerCandidate = enabledPlayerCandidate;
  if (playerCandidate) {
    // ②-00 입단(드래프트) 질문 — **KBO 공식 프로필 필드**로 코드가 답한다.
    //
    // ⚠️ 이건 tier2 숫자 HOLD 를 여는 것이 아니다(2026-08-09 삼순 설계 정정).
    //   선수 tier2(나무위키) 문장에서 연도를 캐내면 같은 chunk 안 데뷔·이적·FA 와
    //   구분할 수 없다 — #1110 에서 13커밋을 쌓았다 지운 그 반대가설이다.
    //   반면 공식 `lblDraft`(`11 LG 1라운드 2순위`)는 **뜻이 하나뿐인 구조화 필드**라
    //   그 반대가설이 성립하지 않는다. 그래서 파싱이 아니라 조회고, RAG·LLM·cache 를
    //   한 번도 태우지 않는다.
    //
    //   공식값이 없으면 **지어내지 않고** 구체적으로 없다고 말한다(fail-close).
    if (isDraftQuestion(question)) {
      const rosterPlayer = players.find((player) => player.kboId === playerCandidate.entityId);
      const raw = rosterPlayer?.draft;
      const draft = parseDraftLabel(raw, deps.now ? new Date(deps.now()) : new Date());
      const answer = draft
        ? renderDraftAnswer(playerCandidate.name, draft, {
            // 질문이 다른 구단을 지목했으면 밝힌다 — `박병호는 키움에 언제 입단?` 에
            // "2005년 LG 입단" 만 주면 유저는 키움 입단으로 읽는다(삼순 P0-3).
            askedTeam: resolveMentionedTeam(question),
            // 순번을 물었으면 순번을 답한다. 연도만 주면 질문에 답하지 않은 것이다.
            wantsDetail: asksDraftDetail(question),
          })
        : renderDraftUnavailable(playerCandidate.name, draftUnavailableReason(raw));
      // 공식 정본에서 온 값이므로 시즌 기록과 같은 칸(`kbo_structured`)에 기록한다.
      // 값이 없어 닫은 경우는 답변이 아니므로 `blocked` 로 분리한다 — 감사 분모가 갈린다.
      const matchPath: MatchPath = draft ? "kbo_structured" : "blocked";
      await deps.log({
        userId, question, questionNorm, matchPath, answer,
        inputTokens: null, outputTokens: null,
      });
      return { status: 200, answer, source: matchPath, remaining };
    }
    // ②-0 시즌 기록(수치) 질문은 위키가 아니라 **구조화 DB** 를 본다 (kbo_structured).
    // 나무위키 숫자는 정본이 아니므로(§12 수치 계약) tier2 로 답하면 안 되고,
    // 그렇다고 차단해도 안 된다 — 하린아빠 2026-08-03 "기록도 레퍼런스하는거야?".
    if (deps.fetchSeasonRecord) {
      const rosterPlayer = players.find((player) => player.kboId === playerCandidate.entityId);
      const preferredTable = rosterPlayer?.position?.includes("투수") ? "pitcher" : "batter";
      const boundIntent = resolveSeasonRecordIntent(question, preferredTable);
      const record = await answerSeasonRecordQuestion(
        userId, question, questionNorm, playerCandidate, remaining, deps, boundIntent,
      );
      if (record) return record;
    }
    if (deps.enablePlayerRag && deps.searchRag && deps.callRagLlm) {
      const descriptive = await answerPlayerDescriptiveQuestion(
        userId, question, questionNorm, playerCandidate, remaining, deps,
        { context: context ?? undefined, rosterBlock },
      );
      // null = 근거 0건 양보 — generic LLM(roster 블록·직전 턴·숫자 계약 보유)으로 내려간다.
      if (descriptive) return descriptive;
    } else {
      // 선수 경로가 꺼져 있어 답을 못 만든 것 — 주제 밖이 아니라 근거 부족이다.
      await deps.log({ userId, question, questionNorm, matchPath: "unsure", answer: UNCLEAR_ANSWER, inputTokens: null, outputTokens: null });
      return { status: 200, answer: UNCLEAR_ANSWER, source: "unsure", remaining };
    }
  }

  // ③ 동일질문 캐시 (토큰 0). 맥락 의존 질문은 global 캐시를 read도 write도 하지 않는다
  // — preseed된 동일 정규화 키가 있어도 맥락 없는 답으로 오염되면 안 된다 (spec §4.1 B5).
  // ⚠️ 로스터 블록이 실리는 질문(로스터 선수 언급)도 캐시 밖이다 — 소속·포지션·등번호는
  //   이적·말소로 **시간에 따라 변하는** 사실이라, 캐시된 옛 답이 현재 roster SSOT 와
  //   어긋날 수 있다(최형우 이적 축과 같은 뿌리). read/write 모두 건너뛴다.
  if (!context && !scopeGate && !rosterBlock) {
    const cached = await deps.getCache(questionNorm);
    if (cached !== null) {
      // 선종결 CAS 결속 (삼순 5차): 캐시 발송도 durable 경계를 이긴 쪽만 한다.
      return settleThroughDurableBoundary(
        { answer: cached, source: "cache" }, cached,
        { userId, question, questionNorm, remaining, deps },
      );
    }
  }

  // ③ 미매칭만 LLM (단발, 이력 미전송). durable job 상태로 동일 messageId의 LLM 소비를
  // 1회로 고정한다 (4차 P1 + 5차 P1): 저장된 결과가 있으면 재사용 → 없으면 atomic
  // CAS(acquireLlmStart)로 정확히 한 worker만 winner가 되어 callLlm을 실행한다.
  // started인데 결과가 없으면 fence로 구분한다: winner가 아직 살아있을 수 있는 창
  // (ownerActive)에는 답변 발송 없이 물러나고(job은 winner 소유), fence가 지나면
  // (응답 수신 후 저장 실패/crash) 자동 재호출 없이 fail-closed 안내로 종결한다.
  let llm: LlmResult | null = null;
  if (deps.getLlmState) {
    let state: { started: boolean; result: LlmResult | null; ownerActive?: boolean };
    try {
      state = await deps.getLlmState();
    } catch {
      // LLM 소비 여부를 모르는 채 진행하지 않는다 (재시도 가능한 실패).
      await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
      return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining };
    }
    llm = state.result;
    // TOCTOU 방어 (삼순 3차): front 가 null 을 본 뒤 다른 worker 가 envelope 를 저장했을
    // 수 있다 — 경계도 공용 helper 로 envelope 를 반드시 인식한다(raw 재검증 금지).
    const boundaryReplayed = await replayStoredFinalResult(llm, { userId, question, questionNorm, remaining, deps });
    if (boundaryReplayed) return boundaryReplayed;
    if (!llm && state.started) {
      if (state.ownerActive) {
        // winner worker가 LLM 경계를 진행 중 — loser는 어떤 답변도 발송하지 않고 물러난다.
        return { status: 202, answer: "", source: "pending", remaining };
      }
      // fence 경과: 이전 시도가 LLM 호출을 시작했지만 결과 저장 전에 죽은 ambiguous 창 —
      // 공급자 응답/과금이 이미 발생했을 수 있으므로 자동 재호출하지 않고 안내로 종결한다.
      await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
      return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining };
    }
  }
  if (!llm) {
    if (deps.acquireLlmStart) {
      let won = false;
      try {
        won = await deps.acquireLlmStart();
      } catch {
        // durable 고정에 실패하면 LLM을 호출하지 않는다 (재시도 가능, LLM 미소비).
        await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
        return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining };
      }
      if (!won) {
        // CAS 패배 — 동시 worker가 방금 winner가 됨. 답변 발송 없이 물러난다 (5차 P1).
        return { status: 202, answer: "", source: "pending", remaining };
      }
    }
    try {
      llm = await deps.callLlm(question, context ?? undefined, rosterBlock);
    } catch {
      // ⚠️ timeout/공급자 오류는 **우리 쪽 고장**이다 (삼순 2026-08-08 ①).
      //   종전에는 `unsure`(판정 불명확)로 접었는데, 그러면 유저는 "질문을 못 알아들었다" 를
      //   받고 멀쩡한 문장을 고쳐 다시 쓴다. 답변·캐시를 안 쓰는 것은 그대로다.
      await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
      return { status: 200, answer: SYSTEM_ERROR_ANSWER, source: "error", remaining };
    }
  }

  const validated = validateLlmResponse(llm.text, question);
  if (validated.kind === "blocked") {
    // 저장 실패는 throw 전파 — 재처리는 ambiguous 경로로 fail-close 되어 재호출이 없다.
    if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer: BLOCKED_ANSWER, source: "blocked" }, llm));
    await deps.log({ userId, question, questionNorm, matchPath: "blocked", answer: null, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer: BLOCKED_ANSWER, source: "blocked", remaining };
  }
  if (validated.kind === "unsure" || !validated.answer) {
    // 추측 금지 → 보류. 캐시 미저장(사전 보강 후 정답 제공 여지).
    if (deps.storeLlm) await deps.storeLlm(packStoredQaFinal({ answer: UNCLEAR_ANSWER, source: "unsure" }, llm));
    await deps.log({ userId, question, questionNorm, matchPath: "unsure", answer: null, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer: UNCLEAR_ANSWER, source: "unsure", remaining };
  }

  // 맥락 의존 답변은 global 캐시에 쓰지 않는다 (spec §4.1 B5).
  // 2차 가드 경로도 쓰지 않는다 — 읽지도 않으므로 써봐야 사장이고, 룰베이스가 못 가린
  // 질문의 답을 공유 캐시에 쌓아두면 나중에 경계가 바뀌었을 때 회수할 수 없다.
  if (deps.storeLlm) {
    await deps.storeLlm(packStoredQaFinal(
      { answer: validated.answer, source: "llm", cacheable: !context && !scopeGate && !rosterBlock },
      llm,
    ));
  }
  if (!context && !scopeGate && !rosterBlock) await deps.setCache(questionNorm, validated.answer);
  await deps.log({ userId, question, questionNorm, matchPath: "llm", answer: validated.answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
  return { status: 200, answer: validated.answer, source: "llm", remaining };
}
