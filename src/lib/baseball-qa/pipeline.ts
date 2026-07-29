// 야구 용어/룰 질문 3단 파이프라인 (spec: specs/baseball-qa-mvp.md §2, §6)
// ①검수 사전(토큰 0) → ②동일질문 캐시 → ③flash-lite LLM(미매칭만).
// DB/LLM 접근은 deps로 주입 → route가 실제 구현, 스모크는 mock으로 검증.

import { normalizeKey, normalizeQuestion } from "./normalize";

export const DAILY_LIMIT = 20;
export const MIN_QUESTION_LEN = 2;
export const MAX_QUESTION_LEN = 200;

export const BLOCKED_ANSWER = "야구 룰/용어에 대한 질문만 답할 수 있어요. 예: \"보크가 뭐야?\"";
export const UNSURE_ANSWER = "잘 모르겠어요. 더 정확히 알게 되면 용어사전에 추가할게요!";

export const NOT_BASEBALL_SENTINEL = "NOT_BASEBALL";
export const UNSURE_SENTINEL = "UNSURE";

export interface GlossaryEntry {
  term: string;
  aliases: string[];
  answer: string;
}

export interface LlmResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type MatchPath = "dictionary" | "cache" | "llm" | "blocked" | "unsure" | "limited" | "error";

export interface QaResult {
  status: number;
  answer: string;
  source: MatchPath;
  term?: string;
  remaining: number;
}

export interface QaDeps {
  loadGlossary: () => Promise<GlossaryEntry[]>;
  getCache: (questionNorm: string) => Promise<string | null>;
  setCache: (questionNorm: string, answer: string) => Promise<void>;
  callLlm: (question: string) => Promise<LlmResult>;
  countToday: (userId: string) => Promise<number>;
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

  // 일일 한도 (사전/캐시 히트도 카운트 — 남용 방지)
  const used = await deps.countToday(userId);
  const remaining = Math.max(0, DAILY_LIMIT - used);
  if (remaining <= 0) {
    await deps.log({ userId, question, questionNorm, matchPath: "limited", answer: null, inputTokens: null, outputTokens: null });
    return { status: 429, answer: "오늘 질문 한도(20개)를 다 썼어요. 내일 다시 물어봐 주세요!", source: "limited", remaining: 0 };
  }

  // ① 검수 사전 (토큰 0)
  const glossary = await deps.loadGlossary();
  const hit = matchGlossary(glossary, question);
  if (hit) {
    await deps.log({ userId, question, questionNorm, matchPath: "dictionary", answer: hit.answer, inputTokens: null, outputTokens: null });
    return { status: 200, answer: hit.answer, source: "dictionary", term: hit.term, remaining: remaining - 1 };
  }

  // ② 동일질문 캐시 (토큰 0)
  const cached = await deps.getCache(questionNorm);
  if (cached !== null) {
    await deps.log({ userId, question, questionNorm, matchPath: "cache", answer: cached, inputTokens: null, outputTokens: null });
    return { status: 200, answer: cached, source: "cache", remaining: remaining - 1 };
  }

  // ③ 미매칭만 LLM (단발, 이력 미전송)
  let llm: LlmResult;
  try {
    llm = await deps.callLlm(question);
  } catch {
    await deps.log({ userId, question, questionNorm, matchPath: "error", answer: null, inputTokens: null, outputTokens: null });
    return { status: 503, answer: "지금은 답변을 가져올 수 없어요. 잠시 후 다시 시도해 주세요.", source: "error", remaining: remaining - 1 };
  }

  const text = llm.text.trim();
  if (text === NOT_BASEBALL_SENTINEL || text.startsWith(NOT_BASEBALL_SENTINEL)) {
    await deps.log({ userId, question, questionNorm, matchPath: "blocked", answer: null, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer: BLOCKED_ANSWER, source: "blocked", remaining: remaining - 1 };
  }
  if (text === UNSURE_SENTINEL || text.startsWith(UNSURE_SENTINEL) || text.length === 0) {
    // 추측 금지 → 보류. 캐시 미저장(사전 보강 후 정답 제공 여지).
    await deps.log({ userId, question, questionNorm, matchPath: "unsure", answer: null, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
    return { status: 200, answer: UNSURE_ANSWER, source: "unsure", remaining: remaining - 1 };
  }

  await deps.setCache(questionNorm, text);
  await deps.log({ userId, question, questionNorm, matchPath: "llm", answer: text, inputTokens: llm.inputTokens, outputTokens: llm.outputTokens });
  return { status: 200, answer: text, source: "llm", remaining: remaining - 1 };
}
