// 야구 용어/룰 질문 3단 파이프라인 (spec: specs/baseball-qa-mvp.md §2, §6)
// ①검수 사전(토큰 0) → ②동일질문 캐시 → ③flash-lite LLM(미매칭만).
// DB/LLM 접근은 deps로 주입 → route가 실제 구현, 스모크는 mock으로 검증.

import {
  isFollowupPhrase,
  selectContextTurn,
  type ContextTurn,
  type PreviousTurnRow,
} from "./context";
import { normalizeKey, normalizeQuestion } from "./normalize";
import {
  allowsNumericAnswer,
  composeRagAnswer,
  isDescriptivePlayerQuestion,
  selectEvidence,
  validateRagResponse,
  type RagEvidence,
  type RagPlayerCandidate,
} from "./rag/retrieve";
import {
  BASEBALL_GENIUS_DAILY_LIMIT,
  BASEBALL_GENIUS_FALLBACK_ANSWER,
  BASEBALL_GENIUS_MAX_ANSWER_LENGTH,
  BASEBALL_GENIUS_MAX_QUESTION_LENGTH,
  BASEBALL_GENIUS_MIN_QUESTION_LENGTH,
} from "@/lib/constants/baseball-genius";

export const DAILY_LIMIT = BASEBALL_GENIUS_DAILY_LIMIT;
export const MIN_QUESTION_LEN = BASEBALL_GENIUS_MIN_QUESTION_LENGTH;
export const MAX_QUESTION_LEN = BASEBALL_GENIUS_MAX_QUESTION_LENGTH;

export const BLOCKED_ANSWER = BASEBALL_GENIUS_FALLBACK_ANSWER;
// LLM이 야구 룰/용어인지 확신하지 못한 경우 — 차단 문구가 아니라 확인 질문이다.
export const UNSURE_ANSWER =
  "어떤 야구 룰/용어를 여쭤보신 걸까요? 조금만 더 자세히 적어주시면 정확히 답해드릴게요! ⚾";
export const SERVICE_REDIRECT_ANSWER =
  "크보팬 서비스 관련 문의는 마이페이지 > 피드백 보내기로 보내주시면 운영팀이 확인해요! 저는 야구 룰/용어 질문을 도와드릴게요 ⚾";
export const HISTORY_HOLD_ANSWER =
  "선수나 구단 기록은 제가 아직 정확히 답해드리기 어려워요. 앱의 선수 페이지 / 기록 탭에서 정확한 기록을 볼 수 있어요!";
// 후속형인데 이어붙일 직전 turn이 없을 때 — 차단 문구가 아니라 정중한 되묻기다 (spec §4.3 AC4).
export const CONTEXT_MISSING_ANSWER =
  "어떤 내용에 이어서 여쭤보시는 걸까요? 궁금한 야구 룰/용어를 한 번만 더 적어주시면 답해드릴게요! ⚾";

export const LLM_AMBIGUOUS_ANSWER =
  "답변을 저장하는 과정에서 문제가 생겨 이번 질문에는 답을 드리지 못했어요. 같은 질문을 다시 보내주시면 새로 답해드릴게요! ⚾";
// 직전 답변에 대한 감사·확인 인사 — 질문이 아니라 대화 행위다. 차단 문구를 보내면 안 된다.
export const ACK_ANSWER = "도움이 됐다니 다행이에요! ⚾";

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

const ACK_SET = new Set(ACK_PHRASES.map(normalizeAck));

/**
 * 단독 감사·확인 인사인지 (폐쇄집합 full-string 완전일치).
 * 뒤에 새 요청절이 붙은 문장(`고마워 근데 날씨 알려줘`)은 일치하지 않으므로 기존 판정으로 간다.
 */
export function isAckPhrase(question: string): boolean {
  return ACK_SET.has(normalizeAck(question));
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

export interface PlayerRef {
  name: string;
  kboId: string;
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
  // 선수 서술형 질문을 수집된 tier2 문서 근거로 답한 경로 (S2b).
  | "rag"
  | "unsure"
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
}

export interface QaDeps {
  loadGlossary: () => Promise<GlossaryEntry[]>;
  loadPlayers: () => Promise<PlayerRef[]>;
  getCache: (questionNorm: string) => Promise<string | null>;
  setCache: (questionNorm: string, answer: string) => Promise<void>;
  callLlm: (question: string, context?: ContextTurn) => Promise<LlmResult>;
  /**
   * 선수 entity로 필터된 tier2 근거 검색 (S2b). 미배선이면 RAG 경로 자체가 비활성이라
   * 기존 동작 그대로다.
   */
  searchRag?: (candidate: RagPlayerCandidate, question: string) => Promise<RagEvidence[]>;
  /** 근거를 **비신뢰 데이터**로만 전달하는 재서술 호출 (S2b). */
  callRagLlm?: (question: string, evidence: RagEvidence[]) => Promise<LlmResult>;
  /** 현재 출시 범위는 룰/용어만이다. 선수 RAG는 후속 출시에서 명시적으로 켠다. */
  enablePlayerRag?: boolean;
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
const TEAM_WORDS = [
  "기아", "두산", "롯데", "삼성", "한화", "키움", "엘지", "lg", "kt", "ssg", "nc",
  "타이거즈", "베어스", "자이언츠", "라이온즈", "이글스", "히어로즈", "트윈스",
  "위즈", "랜더스", "다이노스",
];
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
const NAMED_STAT_QUERY =
  /[가-힣]{2,12}(?:의|은|는|이|가)?\s+(?:타율|방어율|평균자책|출루율|장타율|홈런|안타|타점|도루|승수|세이브|홀드|삼진|기록|스탯)\s*(?:몇|얼마|알려|보여|기록)?/;

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
  const isOutOfScopeRequest = OUT_OF_SCOPE_INTENT.test(normalized) || NAMED_STAT_QUERY.test(normalized);
  const hasBaseballContext =
    exactGlossaryMatch ||
    mentionsSpecificRuleHint ||
    mentionsSpecificRuleSignal ||
    mentionsRoleRule ||
    BASEBALL_WORDS.some((word) => mentionsSignalWord(tokens, word)) ||
    TEAM_WORDS.some((word) => tokenMatches(tokens, word)) ||
    hasPlayerReference(tokens, players);

  // 검수 사전의 실제 용어가 문장에 있으면 축약형(`잔루만루는`)도 용어 질문으로 인정한다.
  // 일반 엔티티 단어가 아니라 132개 검수 용어 폐쇄집합에만 해당한다.
  if (exactGlossaryMatch && !isOutOfScopeRequest) return true;
  if (
    mentionsRuleHint &&
    hasBaseballContext &&
    !hasPlayerReference(tokens, players) &&
    !TEAM_WORDS.some((word) => tokenMatches(tokens, word)) &&
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
  if (TEAM_WORDS.some((word) => tokenMatches(tokens, word))) return false;
  if (OUT_OF_SCOPE_INTENT.test(normalized)) return false;
  if (NAMED_STAT_QUERY.test(normalized)) return false;
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

function tokenMatches(tokens: string[], word: string): boolean {
  const needle = word.toLowerCase();
  return tokens.some((token) => {
    if (token === needle) return true;
    return TOKEN_TRIM_SUFFIXES.some((suffix) => token === `${needle}${suffix}`);
  });
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
  const normalized = question.normalize("NFKC").toLowerCase();
  const tokens = questionTokens(normalized);
  const matched = findPlayerReferences(tokens, players);
  const distinctIds = new Set(matched.map((player) => player.kboId));
  if (distinctIds.size !== 1) return null;
  const target = matched[0];

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
    sourceKey: `namu:player:${target.kboId}`,
  };
}

function hasBaseballSignal(value: string): boolean {
  const tokens = questionTokens(value);
  return BASEBALL_WORDS.some((word) => tokenMatches(tokens, word)) ||
    ["경기", "공격", "수비", "주루", "득점", "홈플레이트", "마운드"].some((word) =>
      tokenMatches(tokens, word)
    );
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
  if (isAckPhrase(question)) return "ack";
  if (SERVICE_WORDS.some((word) => normalized.includes(word))) return "service_redirect";
  const hasStat = STAT_WORDS.some((word) => tokenMatches(tokens, word));
  const hasTeam = TEAM_WORDS.some((word) => tokenMatches(tokens, word));
  if (hasStat && (hasPlayerReference(tokens, players) || hasTeam)) return "blocked";
  const supportedRuleTerm = isSupportedRuleTermQuestion(question, glossary, players);
  if (
    !supportedRuleTerm && (
      HISTORY_CONTEXT_WORDS.some((word) => normalized.includes(word)) ||
    // "순위"는 team-bound일 때만 실시간 기록 질의다. 전역 차단어로 두면
    // "순위 결정 규칙 알려줘"처럼 팀 없는 룰 질문까지 history_hold로 과차단된다.
      (hasTeam && /누구|언제|몇|기록|성적|역사|순위/.test(normalized))
    )
  ) {
    return "blocked";
  }
  // 후속 문법(폐쇄집합 full-string 일치) + 새 야구 엔티티/주제 신호 부재일 때만 직전 토픽 연장.
  // 소스 turn이 없으면 차단이 아니라 되묻기로 종료한다 (spec §4.1 B4, §4.3 AC2·AC3·AC4).
  if (isFollowupPhrase(question)) return hasContext ? "baseball_rule_term" : "context_missing";
  if (supportedRuleTerm) return "baseball_rule_term";

  // 선수·구단을 지명했는데 룰/용어 질문이 아니면 현 출시 범위 밖이다 — 이건 LLM에 묻지 않고
  // 계속 결정론적으로 닫는다. roster·구단명은 폐쇄집합이라 신호어 사전처럼 발산하지 않고,
  // `문보경 별명이 뭐야` 처럼 기록어가 없는 인물 질의까지 LLM 판정에 넘기면 범위 밖 답변과
  // global cache가 생길 수 있다.
  if (hasTeam || hasPlayerReference(tokens, players)) return "blocked";

  // 기존 범위밖 의도 denylist도 그대로 유지한다. 이건 신호어 사전처럼 "야구 어휘를 전부
  // 열거해야 하는" 종류가 아니라 범위밖임이 문장 의도로 드러난 고정밀 패턴이라 발산하지
  // 않는다(별명·누구·비교·역대·추천·날씨 등). 이걸까지 LLM에 묻면 토큰만 더 쓴다.
  if (OUT_OF_SCOPE_INTENT.test(normalized) || NAMED_STAT_QUERY.test(normalized)) return "blocked";

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

/** JSON 스키마·센티널·출력 안전성 검증을 모두 통과한 답만 캐시 가능하다. */
export function validateLlmResponse(raw: string): ValidatedLlmAnswer {
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
    !hasBaseballSignal(answer)
  ) {
    return { kind: "unsure" };
  }
  return { kind: "answer", answer };
}

/** 사전에서 정규화 exact 매칭 (term/alias 각각 key·question 두 정규화 레벨로 인덱싱) */
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
async function answerPlayerDescriptiveQuestion(
  userId: string,
  question: string,
  questionNorm: string,
  candidate: RagPlayerCandidate,
  remaining: number,
  deps: QaDeps,
): Promise<QaResult> {
  const failClose = async (): Promise<QaResult> => {
    // 근거로 답할 수 없는 선수 서술형 질문은 기존과 동일한 안내로 종결한다.
    // 중요한 건 문구가 아니라 **여기서 끝난다**는 것이다: generic LLM 호출도 cache write도 없다.
    await deps.log({ userId, question, questionNorm, matchPath: "blocked", answer: BLOCKED_ANSWER, inputTokens: null, outputTokens: null });
    return { status: 200, answer: BLOCKED_ANSWER, source: "blocked", remaining };
  };
  const failCloseError = async (): Promise<QaResult> => {
    await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
    return { status: 200, answer: BLOCKED_ANSWER, source: "error", remaining };
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
    return failClose();
  }
  // 미커버 선수(0행)·sanitize 뒤 남는 근거 없음(오염근거) — 둘 다 여기서 명시 종결한다.
  if (evidence.length === 0) return failClose();

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
      llm = await deps.callRagLlm!(question, evidence);
    } catch {
      return failClose();
    }
    // 저장 실패는 throw로 전파 — 재처리는 위 ambiguous 경로로 fail-close되어 재호출이 없다.
    if (deps.storeLlm) await deps.storeLlm(llm);
  }

  const validated = validateRagResponse(llm.text);
  if (validated.kind !== "grounded") return failClose();
  const answer = composeRagAnswer(validated.answer, evidence[0]);
  await deps.log({ userId, question, questionNorm, matchPath: "rag", answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
  return { status: 200, answer, source: "rag", remaining };
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
    return { status: 200, answer: BLOCKED_ANSWER, source: "error", remaining };
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
    if (deps.storeLlm) await deps.storeLlm(llm);
  }

  const validated = validateRagResponse(llm.text, { numericEvidence: true, evidence });
  if (validated.kind !== "grounded") {
    // 공식 근거로도 답을 못 만들었다. LLM 호출을 이미 써서 일반 경로 재호출은 안 된다.
    await deps.log({ userId, question, questionNorm, matchPath: "unsure", answer: BLOCKED_ANSWER, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer: BLOCKED_ANSWER, source: "unsure", remaining };
  }
  const answer = composeRagAnswer(validated.answer, evidence[0]);
  await deps.log({ userId, question, questionNorm, matchPath: "rag", answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
  return { status: 200, answer, source: "rag", remaining };
}

export async function answerQuestion(userId: string, rawQuestion: string, deps: QaDeps): Promise<QaResult> {
  const question = rawQuestion.trim();
  const questionNorm = normalizeQuestion(question);

  // KST 일자 버킷 원자 예약. DB 오류도 fail-closed하여 LLM에 진입하지 않는다.
  let reservation: { allowed: boolean; remaining: number };
  try {
    reservation = await deps.reserveDaily(userId, DAILY_LIMIT);
  } catch {
    return { status: 200, answer: BLOCKED_ANSWER, source: "error", remaining: 0 };
  }
  if (!reservation.allowed) {
    await deps.log({ userId, question, questionNorm, matchPath: "limited", answer: null, inputTokens: null, outputTokens: null });
    return {
      status: 429,
      answer: `오늘 질문 한도(${DAILY_LIMIT}개)를 다 썼어요. 내일 다시 물어봐 주세요!`,
      source: "limited",
      remaining: 0,
    };
  }
  const remaining = reservation.remaining;

  const [glossary, players] = await Promise.all([deps.loadGlossary(), deps.loadPlayers()]);
  // 맥락 조회는 후속 문법일 때만 — 일반 질문은 기존 경로 그대로다 (spec §4.1 B4).
  // 조회 실패는 맥락 없음으로 fail-closed 한다.
  let context: ContextTurn | null = null;
  if (deps.loadPreviousTurn && isFollowupPhrase(question)) {
    try {
      context = selectContextTurn(await deps.loadPreviousTurn());
    } catch {
      context = null;
    }
  }
  // 선수 RAG는 후속 출시용 explicit flag가 켜진 테스트/환경에서만 현재 룰·용어 경계를 우회한다.
  // Production은 server.ts에서 false로 고정되어 선수·구단 질문이 provider/cache에 닿지 않는다.
  const enabledPlayerCandidate = deps.enablePlayerRag
    ? resolveRagPlayerCandidate(question, players)
    : null;
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
  const scopeGate = route === "llm_scope_gate";
  if (route !== "baseball_rule_term" && !scopeGate) {
    const answer =
      route === "service_redirect" ? SERVICE_REDIRECT_ANSWER :
      route === "history_hold" ? HISTORY_HOLD_ANSWER :
      route === "context_missing" ? CONTEXT_MISSING_ANSWER :
      route === "ack" ? ACK_ANSWER :
      BLOCKED_ANSWER;
    await deps.log({ userId, question, questionNorm, matchPath: route, answer, inputTokens: null, outputTokens: null });
    return { status: 200, answer, source: route, remaining };
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

  // ② 선수 서술형 질문은 수집된 tier2 문서 근거로만 답한다 (S2b).
  // ⚠️ **global 캐시보다 앞**에 둔다 (삼순 R3/R4 P0-3). 캐시가 먼저면 과거에 저장된
  // 근거 없는 답(오염 캐시 포함)이 선수 질문의 답으로 재노출되고 RAG 경로가 통째로
  // 무시된다 — 실제로 `문보경 별명이 뭐야?` 에 preseed 캐시를 넣으면 source=cache 로
  // 재현됐다. 이 분기에 들어오면 **여기서 종결**한다: 근거가 있으면 rag 답변,
  // 근거 0건·근거부족·오염근거는 generic LLM 0 / cache 0 으로 명시 fail-close 한다.
  const playerCandidate = enabledPlayerCandidate;
  if (playerCandidate) {
    if (deps.enablePlayerRag && deps.searchRag && deps.callRagLlm) {
      return answerPlayerDescriptiveQuestion(userId, question, questionNorm, playerCandidate, remaining, deps);
    }
    await deps.log({ userId, question, questionNorm, matchPath: "blocked", answer: BLOCKED_ANSWER, inputTokens: null, outputTokens: null });
    return { status: 200, answer: BLOCKED_ANSWER, source: "blocked", remaining };
  }

  // ③ 동일질문 캐시 (토큰 0). 맥락 의존 질문은 global 캐시를 read도 write도 하지 않는다
  // — preseed된 동일 정규화 키가 있어도 맥락 없는 답으로 오염되면 안 된다 (spec §4.1 B5).
  if (!context && !scopeGate) {
    const cached = await deps.getCache(questionNorm);
    if (cached !== null) {
      await deps.log({ userId, question, questionNorm, matchPath: "cache", answer: cached, inputTokens: null, outputTokens: null });
      return { status: 200, answer: cached, source: "cache", remaining };
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
      return { status: 200, answer: BLOCKED_ANSWER, source: "error", remaining };
    }
    llm = state.result;
    if (!llm && state.started) {
      if (state.ownerActive) {
        // winner worker가 LLM 경계를 진행 중 — loser는 어떤 답변도 발송하지 않고 물러난다.
        return { status: 202, answer: "", source: "pending", remaining };
      }
      // fence 경과: 이전 시도가 LLM 호출을 시작했지만 결과 저장 전에 죽은 ambiguous 창 —
      // 공급자 응답/과금이 이미 발생했을 수 있으므로 자동 재호출하지 않고 안내로 종결한다.
      await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
      return { status: 200, answer: BLOCKED_ANSWER, source: "error", remaining };
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
        return { status: 200, answer: BLOCKED_ANSWER, source: "error", remaining };
      }
      if (!won) {
        // CAS 패배 — 동시 worker가 방금 winner가 됨. 답변 발송 없이 물러난다 (5차 P1).
        return { status: 202, answer: "", source: "pending", remaining };
      }
    }
    try {
      llm = await deps.callLlm(question, context ?? undefined);
    } catch {
      // timeout/공급자 오류도 판정 불명확이다. 답변·캐시 없이 확인 질문으로 fail-close한다.
      await deps.log({ userId, question, questionNorm, matchPath: "unsure", answer: null, inputTokens: null, outputTokens: null });
      return { status: 200, answer: BLOCKED_ANSWER, source: "unsure", remaining };
    }
    // 저장 실패는 throw로 전파 — 재처리는 위 ambiguous 경로로 fail-closed되어 재호출이 없다.
    if (deps.storeLlm) await deps.storeLlm(llm);
  }

  const validated = validateLlmResponse(llm.text);
  if (validated.kind === "blocked") {
    await deps.log({ userId, question, questionNorm, matchPath: "blocked", answer: null, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer: BLOCKED_ANSWER, source: "blocked", remaining };
  }
  if (validated.kind === "unsure" || !validated.answer) {
    // 추측 금지 → 보류. 캐시 미저장(사전 보강 후 정답 제공 여지).
    await deps.log({ userId, question, questionNorm, matchPath: "unsure", answer: null, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer: BLOCKED_ANSWER, source: "unsure", remaining };
  }

  // 맥락 의존 답변은 global 캐시에 쓰지 않는다 (spec §4.1 B5).
  // 2차 가드 경로도 쓰지 않는다 — 읽지도 않으므로 써봐야 사장이고, 룰베이스가 못 가린
  // 질문의 답을 공유 캐시에 쌓아두면 나중에 경계가 바뀌었을 때 회수할 수 없다.
  if (!context && !scopeGate) await deps.setCache(questionNorm, validated.answer);
  await deps.log({ userId, question, questionNorm, matchPath: "llm", answer: validated.answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
  return { status: 200, answer: validated.answer, source: "llm", remaining };
}
