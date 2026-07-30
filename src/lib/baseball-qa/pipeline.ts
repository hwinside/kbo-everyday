// 야구 용어/룰 질문 3단 파이프라인 (spec: specs/baseball-qa-mvp.md §2, §6)
// ①검수 사전(토큰 0) → ②동일질문 캐시 → ③flash-lite LLM(미매칭만).
// DB/LLM 접근은 deps로 주입 → route가 실제 구현, 스모크는 mock으로 검증.

import { normalizeKey, normalizeQuestion } from "./normalize";
import {
  BASEBALL_GENIUS_DAILY_LIMIT,
  BASEBALL_GENIUS_MAX_ANSWER_LENGTH,
  BASEBALL_GENIUS_MAX_QUESTION_LENGTH,
  BASEBALL_GENIUS_MIN_QUESTION_LENGTH,
} from "@/lib/constants/baseball-genius";

export const DAILY_LIMIT = BASEBALL_GENIUS_DAILY_LIMIT;
export const MIN_QUESTION_LEN = BASEBALL_GENIUS_MIN_QUESTION_LENGTH;
export const MAX_QUESTION_LEN = BASEBALL_GENIUS_MAX_QUESTION_LENGTH;

export const BLOCKED_ANSWER = "야구 룰/용어에 대한 질문만 답할 수 있어요. 예: \"보크가 뭐야?\"";
export const UNSURE_ANSWER = "잘 모르겠어요. 더 정확히 알게 되면 용어사전에 추가할게요!";
export const SERVICE_REDIRECT_ANSWER =
  "크보팬 서비스 관련 문의는 마이페이지 > 피드백 보내기로 보내주시면 운영팀이 확인해요! 저는 야구 룰/용어 질문을 도와드릴게요 ⚾";
export const HISTORY_HOLD_ANSWER =
  "선수나 구단 기록은 제가 아직 정확히 답해드리기 어려워요. 앱의 선수 페이지 / 기록 탭에서 정확한 기록을 볼 수 있어요!";

export const LLM_AMBIGUOUS_ANSWER =
  "답변을 저장하는 과정에서 문제가 생겨 이번 질문에는 답을 드리지 못했어요. 같은 질문을 다시 보내주시면 새로 답해드릴게요! ⚾";

export const NOT_BASEBALL_SENTINEL = "NOT_BASEBALL";
export const UNSURE_SENTINEL = "UNSURE";

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

export type QuestionRoute = "service_redirect" | "history_hold" | "blocked" | "baseball_rule_term";
export type MatchPath =
  | "dictionary"
  | "cache"
  | "llm"
  | "service_redirect"
  | "history_hold"
  | "blocked"
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
  callLlm: (question: string) => Promise<LlmResult>;
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
  "홈런", "안타", "타점", "도루", "승", "패", "세이브", "홀드", "삼진", "기록", "스탯",
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
  "규칙", "용어", "타율", "방어율", "평균자책", "기록", "스탯", "war",
];
const INJECTION_PATTERNS = [
  /이전\s*(지시|명령).*(무시|잊)/i,
  /(시스템|개발자)\s*(프롬프트|메시지|지시)/i,
  /ignore\s+(all\s+)?previous/i,
  /(링크|url).*(줘|출력|보여)/i,
];

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

function hasPlayerReference(tokens: string[], players: PlayerRef[]): boolean {
  // 선수명·KBO ID에도 일반 단어와 동일한 허용 조사 경계(tokenMatches)를 적용한다.
  // "김도영의", "류현진은", "박해민이", "52605의" 같은 조사 결합형이 exact 미스로
  // history_hold를 우회해 LLM/캐시에 진입하는 것을 막는다 (삼순 3차 P0).
  return players.some((player) => {
    const name = player.name.normalize("NFKC").toLowerCase().trim();
    const kboId = player.kboId.normalize("NFKC").toLowerCase().trim();
    return (name.length >= 2 && tokenMatches(tokens, name)) ||
      (kboId.length >= 3 && tokenMatches(tokens, kboId));
  });
}

function hasBaseballSignal(value: string): boolean {
  const tokens = questionTokens(value);
  return BASEBALL_WORDS.some((word) => tokenMatches(tokens, word)) ||
    ["경기", "공격", "수비", "주루", "득점", "홈플레이트", "마운드"].some((word) =>
      tokenMatches(tokens, word)
    );
}

/** LLM 전에 실행하는 보수적 4갈래 라우터. 불명확하면 fail-closed 한다. */
export function routeQuestion(
  question: string,
  glossary: GlossaryEntry[] = [],
  players: PlayerRef[] = [],
): QuestionRoute {
  const normalized = question.normalize("NFKC").toLowerCase();
  const tokens = questionTokens(normalized);
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(normalized))) return "blocked";
  if (SERVICE_WORDS.some((word) => normalized.includes(word))) return "service_redirect";
  const hasStat = STAT_WORDS.some((word) => tokenMatches(tokens, word));
  const hasTeam = TEAM_WORDS.some((word) => tokenMatches(tokens, word));
  if (hasStat && (hasPlayerReference(tokens, players) || hasTeam)) return "history_hold";
  if (
    HISTORY_CONTEXT_WORDS.some((word) => normalized.includes(word)) ||
    (hasTeam && /누구|언제|몇|기록|성적|역사/.test(normalized))
  ) {
    return "history_hold";
  }
  if (matchGlossary(glossary, question)) return "baseball_rule_term";
  const mentionsGlossaryTerm = glossary.some((entry) =>
    [entry.term, ...entry.aliases].some((name) => {
      const normalizedName = name.normalize("NFKC").toLowerCase().trim();
      return normalizedName.length >= 2 && tokenMatches(tokens, normalizedName);
    })
  );
  if (mentionsGlossaryTerm) return "baseball_rule_term";
  if (BASEBALL_WORDS.some((word) => tokenMatches(tokens, word))) return "baseball_rule_term";
  return "blocked";
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
  if (!["ANSWER", NOT_BASEBALL_SENTINEL, UNSURE_SENTINEL].includes(String(row.status))) {
    return { kind: "unsure" };
  }
  if (row.status === NOT_BASEBALL_SENTINEL) return { kind: "blocked" };
  if (row.status === UNSURE_SENTINEL) return { kind: "unsure" };
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

export async function answerQuestion(userId: string, rawQuestion: string, deps: QaDeps): Promise<QaResult> {
  const question = rawQuestion.trim();
  const questionNorm = normalizeQuestion(question);

  // KST 일자 버킷 원자 예약. DB 오류도 fail-closed하여 LLM에 진입하지 않는다.
  let reservation: { allowed: boolean; remaining: number };
  try {
    reservation = await deps.reserveDaily(userId, DAILY_LIMIT);
  } catch {
    return { status: 503, answer: "지금은 질문 한도를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.", source: "error", remaining: 0 };
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
  const route = routeQuestion(question, glossary, players);
  if (route !== "baseball_rule_term") {
    const answer =
      route === "service_redirect" ? SERVICE_REDIRECT_ANSWER :
      route === "history_hold" ? HISTORY_HOLD_ANSWER :
      BLOCKED_ANSWER;
    await deps.log({ userId, question, questionNorm, matchPath: route, answer, inputTokens: null, outputTokens: null });
    return { status: 200, answer, source: route, remaining };
  }

  // ① 검수 사전 (토큰 0)
  const hit = matchGlossary(glossary, question);
  if (hit) {
    await deps.log({ userId, question, questionNorm, matchPath: "dictionary", answer: hit.answer, inputTokens: null, outputTokens: null });
    return { status: 200, answer: hit.answer, source: "dictionary", term: hit.term, remaining };
  }

  // ② 동일질문 캐시 (토큰 0)
  const cached = await deps.getCache(questionNorm);
  if (cached !== null) {
    await deps.log({ userId, question, questionNorm, matchPath: "cache", answer: cached, inputTokens: null, outputTokens: null });
    return { status: 200, answer: cached, source: "cache", remaining };
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
      return { status: 503, answer: "지금은 답변을 가져올 수 없어요. 잠시 후 다시 시도해 주세요.", source: "error", remaining };
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
      return { status: 200, answer: LLM_AMBIGUOUS_ANSWER, source: "error", remaining };
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
        return { status: 503, answer: "지금은 답변을 가져올 수 없어요. 잠시 후 다시 시도해 주세요.", source: "error", remaining };
      }
      if (!won) {
        // CAS 패배 — 동시 worker가 방금 winner가 됨. 답변 발송 없이 물러난다 (5차 P1).
        return { status: 202, answer: "", source: "pending", remaining };
      }
    }
    try {
      llm = await deps.callLlm(question);
    } catch {
      await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
      return { status: 503, answer: "지금은 답변을 가져올 수 없어요. 잠시 후 다시 시도해 주세요.", source: "error", remaining };
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
    return { status: 200, answer: UNSURE_ANSWER, source: "unsure", remaining };
  }

  await deps.setCache(questionNorm, validated.answer);
  await deps.log({ userId, question, questionNorm, matchPath: "llm", answer: validated.answer, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
  return { status: 200, answer: validated.answer, source: "llm", remaining };
}
