// 야잘알봇 질문 서버 처리 코어. POST /api/baseball-qa(즉시 경로)와
// /api/cron/baseball-qa-drain(durable 복구 경로)이 같은 처리기를 공유한다.
// 질문 INSERT와 같은 트랜잭션에서 trigger가 만든 genius_question_jobs 행을
// claim → (idempotent quota/LLM) 파이프라인 → ready 저장 → 답변 DM → completed 순으로 진행한다.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendOpsMessageToUser } from "@/lib/cs/send-ops-message";
import {
  answerQuestion,
  isAckPhrase,
  MAX_QUESTION_LEN,
  MIN_QUESTION_LEN,
  type GlossaryEntry,
  type LlmResult,
  type PlayerRef,
  type QaDeps,
  type QaResult,
} from "@/lib/baseball-qa/pipeline";
import {
  isFollowupPhrase,
  type ContextTurn,
  type PreviousTurnRow,
} from "@/lib/baseball-qa/context";
import { BASEBALL_GENIUS_USER_ID } from "@/lib/constants/baseball-genius";
import playersRoster from "@/lib/constants/players-roster.json";
import {
  BASEBALL_QA_GEMINI_MODEL,
  BASEBALL_QA_SYSTEM_PROMPT,
  buildBaseballQaGeminiRequest,
} from "@/lib/baseball-qa/gemini-request";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
/** 프롬프트 SSOT는 gemini-request.ts — 실 provider 게이트가 같은 문자열을 import해 검증한다. */
const SYSTEM_PROMPT = BASEBALL_QA_SYSTEM_PROMPT;

/** 발송(delivery) 재시도 상한 — 처리(attempts) 상한과 분리된다 (삼순 4차 P1). */
export const MAX_DELIVERY_ATTEMPTS = 5;
/**
 * LLM 시작 fence (삼순 5차 P1): llm_started=true·결과 없음이어도 시작 후 이 창 안에서는
 * winner의 callLlm(15s timeout)이 아직 진행 중일 수 있으므로 loser는 답변 없이 물러난다.
 * fence 경과 후에만(winner는 이미 성공 저장 또는 사망) ambiguous fail-closed 복구가 동작한다.
 */
export const LLM_START_FENCE_MS = 30_000;
const DELIVERY_RETRY_BACKOFF_SECONDS = 60;

export const INVALID_QUESTION_ANSWER =
  `질문은 ${MIN_QUESTION_LEN}~${MAX_QUESTION_LEN}자 텍스트로 입력해 주세요. 예: "보크가 뭐야?"`;

let glossaryCache: { entries: GlossaryEntry[]; loadedAt: number } | null = null;
const GLOSSARY_TTL_MS = 10 * 60 * 1000;
const ROSTER_PLAYERS: PlayerRef[] = playersRoster.map(({ name, kboId }) => ({ name, kboId }));

async function loadGlossary(): Promise<GlossaryEntry[]> {
  if (glossaryCache && Date.now() - glossaryCache.loadedAt < GLOSSARY_TTL_MS) {
    return glossaryCache.entries;
  }
  const { data, error } = await supabaseAdmin
    .from("baseball_terms")
    .select("term, aliases, answer")
    .limit(1000);
  if (error) throw error;
  const entries = (data ?? []) as GlossaryEntry[];
  glossaryCache = { entries, loadedAt: Date.now() };
  return entries;
}

async function loadPlayers(): Promise<PlayerRef[]> {
  return ROSTER_PLAYERS;
}

async function callLlm(question: string, context?: ContextTurn): Promise<LlmResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildBaseballQaGeminiRequest(question, SYSTEM_PROMPT, context)),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Gemini API failed: ${res.status}`);
  const data = await res.json();
  const text: string =
    data.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ?? "";
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount ?? null,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
  };
}

/** baseball_genius_previous_turn RPC 반환 행 (snake_case SQL 시그니처). */
interface PreviousTurnRowSql {
  question: string | null;
  answer: string | null;
  job_source: string | null;
  answered_at: string | null;
  current_created_at: string | null;
}

/** messageId에 바인딩된 deps — quota/LLM을 job 행 기준 durable idempotent로 만든다. */
function makeDeps(messageId: number): QaDeps {
  return {
    loadGlossary,
    loadPlayers,
    callLlm,
    getCache: async (questionNorm) => {
      const { data, error } = await supabaseAdmin
        .from("genius_qa_cache")
        .select("id, answer, hit_count")
        .eq("question_norm", questionNorm)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      await supabaseAdmin
        .from("genius_qa_cache")
        .update({ hit_count: (data.hit_count ?? 0) + 1, last_hit_at: new Date().toISOString() })
        .eq("id", data.id);
      return data.answer as string;
    },
    // spec §4.1 B1·B2: 바로 직전 user turn 1행만 가져온다 (과거 폴백 없음).
    loadPreviousTurn: async () => {
      // query-guard: bounded -- 직전 turn RPC는 messageId 기준 최대 한 행만 반환한다.
      const { data, error } = await supabaseAdmin
        .rpc("baseball_genius_previous_turn", { p_message_id: messageId });
      if (error) throw error;
      const row = (data as PreviousTurnRowSql[] | null)?.[0];
      if (!row) return null;
      return {
        question: row.question,
        answer: row.answer,
        jobSource: row.job_source,
        answeredAt: row.answered_at,
        currentCreatedAt: row.current_created_at,
      } satisfies PreviousTurnRow;
    },
    setCache: async (questionNorm, answer) => {
      const { error } = await supabaseAdmin
        .from("genius_qa_cache")
        .upsert({ question_norm: questionNorm, answer }, { onConflict: "question_norm" });
      if (error) throw error;
    },
    reserveDaily: async (userId, limit) => {
      // query-guard: bounded -- messageId 단위 idempotent RPC는 결정 한 행만 반환한다.
      const { data, error } = await supabaseAdmin
        .rpc("reserve_baseball_genius_daily_question_for_message", {
          p_message_id: messageId,
          p_user_id: userId,
          p_limit: limit,
        })
        .single();
      if (error) throw error;
      const row = data as { allowed: boolean; remaining: number } | null;
      if (!row) throw new Error("daily reservation missing");
      return { allowed: row.allowed, remaining: Number(row.remaining) };
    },
    getLlmState: async () => {
      const { data, error } = await supabaseAdmin
        .from("genius_question_jobs")
        .select("llm_started, llm_started_at, llm_text, llm_input_tokens, llm_output_tokens")
        .eq("message_id", messageId)
        .maybeSingle();
      if (error) throw error;
      const started = data?.llm_started === true;
      const result = data?.llm_text
        ? {
            text: data.llm_text as string,
            inputTokens: data.llm_input_tokens as number | null,
            outputTokens: data.llm_output_tokens as number | null,
          }
        : null;
      const startedAtMs = data?.llm_started_at ? Date.parse(data.llm_started_at as string) : NaN;
      return {
        started,
        result,
        // winner의 LLM 호출이 아직 끝나지 않았을 수 있는 fence 창 (삼순 5차 P1).
        ownerActive:
          started && !result && Number.isFinite(startedAtMs) &&
          Date.now() - startedAtMs < LLM_START_FENCE_MS,
      };
    },
    acquireLlmStart: async () => {
      // 단일 UPDATE ... WHERE llm_started=false (PostgREST 한 요청 = 원자 CAS).
      // 정확히 한 worker만 1행을 돌려받아 winner가 된다 (삼순 5차 P1).
      const { data, error } = await supabaseAdmin
        .from("genius_question_jobs")
        .update({
          llm_started: true,
          llm_started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", messageId)
        .eq("llm_started", false)
        .select("message_id");
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },
    storeLlm: async (result) => {
      const { error } = await supabaseAdmin
        .from("genius_question_jobs")
        .update({
          llm_text: result.text,
          llm_input_tokens: result.inputTokens,
          llm_output_tokens: result.outputTokens,
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", messageId);
      if (error) throw error;
    },
    log: async (entry) => {
      const { error } = await supabaseAdmin.from("genius_question_logs").insert({
        user_id: entry.userId,
        question: entry.question,
        question_norm: entry.questionNorm,
        match_path: entry.matchPath,
        answer: entry.answer,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
      });
      if (error) throw error;
    },
  };
}

export type ProcessOutcome =
  | { kind: "completed"; deduped?: boolean; source?: string; remaining?: number; conversationId?: string | null }
  | { kind: "pending" }
  | { kind: "failed"; status: number; reason: string };

export async function processBaseballQaQuestion(input: {
  messageId: number;
  conversationId: string;
  userId: string;
  question: string;
}): Promise<ProcessOutcome> {
  const { messageId, conversationId, userId } = input;
  const question = input.question.trim();
  const dedupKey = `baseball-genius:${messageId}`;

  const { data: existing } = await supabaseAdmin
    .from("dm_messages")
    .select("id")
    .eq("dedup_key", dedupKey)
    .eq("sender_id", BASEBALL_GENIUS_USER_ID)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (existing) {
    await supabaseAdmin
      .from("genius_question_jobs")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("message_id", messageId)
      .neq("status", "completed");
    return { kind: "completed", deduped: true };
  }

  // query-guard: bounded -- messageId PK claim은 claim_state 한 행만 반환한다.
  const { data: claim, error: claimError } = await supabaseAdmin
    .rpc("claim_baseball_genius_question", {
      p_message_id: messageId,
      p_conversation_id: conversationId,
      p_user_id: userId,
      p_lease_seconds: 30,
    })
    .single();
  if (claimError || !claim) {
    console.error("baseball-genius claim failed:", claimError?.message ?? "missing claim");
    return { kind: "failed", status: 503, reason: "답변 처리를 시작할 수 없습니다" };
  }
  const claimState = (claim as { claim_state: string }).claim_state;
  if (claimState === "completed") return { kind: "completed", deduped: true };
  if (claimState === "processing") return { kind: "pending" };

  let result: QaResult | null = null;
  if (claimState === "ready") {
    const { data: readyJob, error: readyError } = await supabaseAdmin
      .from("genius_question_jobs")
      .select("answer, source, remaining")
      .eq("message_id", messageId)
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .eq("status", "ready")
      .maybeSingle();
    if (readyError || !readyJob?.answer || !readyJob.source) {
      return { kind: "failed", status: 503, reason: "저장된 답변을 확인할 수 없습니다" };
    }
    result = {
      status: 200,
      answer: readyJob.answer,
      source: readyJob.source as QaResult["source"],
      remaining: Number(readyJob.remaining ?? 0),
    };
  } else {
    try {
      // trigger는 모든 질문 메시지에 job을 만들므로 길이 위반도 여기서 안내 답변으로 종결한다.
      // 단 폐쇄집합 후속어("또"·"더"·"왜")와 감사 인사("ㄳ")는 1자라 최소 길이 게이트에 걸리므로
      // 이 열거된 집합만 예외로 통과시킨다 (spec §4.1 B4 closed-set 도달성).
      const tooShort = question.length < MIN_QUESTION_LEN &&
        !isFollowupPhrase(question) && !isAckPhrase(question);
      if (tooShort || question.length > MAX_QUESTION_LEN) {
        result = { status: 200, answer: INVALID_QUESTION_ANSWER, source: "blocked", remaining: 0 };
      } else {
        result = await answerQuestion(userId, question, makeDeps(messageId));
      }
      if (result.source === "pending") {
        // LLM winner가 다른 worker (CAS 패배/fence 창) — 이 worker는 ready 저장도 발송도 하지
        // 않고 물러난다. job은 winner가 끝까지 소유하며, winner crash 시에만 다음 drain이
        // fence 경과 후 ambiguous fail-closed 복구로 이어받는다 (삼순 5차 P1).
        return { kind: "pending" };
      }
      const { error: readyError } = await supabaseAdmin
        .from("genius_question_jobs")
        .update({
          status: "ready",
          answer: result.answer,
          source: result.source,
          remaining: result.remaining,
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", messageId)
        .eq("status", "processing");
      if (readyError) throw readyError;
    } catch (error) {
      console.error("baseball-genius pipeline failed:", (error as Error).message);
      await supabaseAdmin
        .from("genius_question_jobs")
        .update({
          status: "failed",
          last_error: "pipeline_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", messageId)
        .eq("status", "processing");
      return { kind: "failed", status: 503, reason: "답변 생성에 실패했습니다" };
    }
  }

  const sent = await sendOpsMessageToUser(
    supabaseAdmin,
    BASEBALL_GENIUS_USER_ID,
    userId,
    result.answer,
    dedupKey,
    "dm",
  );
  if (!sent.ok) {
    console.error("baseball-genius DM reply failed:", sent.reason);
    // 발송 실패는 status=ready를 유지한 채 delivery_attempts만 증가시켜(backoff lease)
    // 다음 drain이 저장된 답변으로 발송만 재시도한다 (삼순 4차 P1).
    // query-guard: bounded -- messageId 단위 단일 행 갱신 RPC.
    const { data: deliveryAttempts, error: deliveryError } = await supabaseAdmin
      .rpc("record_baseball_genius_delivery_failure", {
        p_message_id: messageId,
        p_backoff_seconds: DELIVERY_RETRY_BACKOFF_SECONDS,
      });
    if (deliveryError) {
      console.error("baseball-genius delivery failure record failed:", deliveryError.message);
    } else if (Number(deliveryAttempts) >= MAX_DELIVERY_ATTEMPTS) {
      // 관측/알림: 상한 소진 job은 drain 대상에서 빠지므로 운영 로그로 표면화한다.
      console.error(
        `baseball-genius delivery exhausted: message ${messageId} (${deliveryAttempts}/${MAX_DELIVERY_ATTEMPTS})`,
      );
    }
    return { kind: "failed", status: 500, reason: "답변 쪽지 발송에 실패했습니다" };
  }
  await supabaseAdmin
    .from("genius_question_jobs")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("message_id", messageId);
  return {
    kind: "completed",
    source: result.source,
    remaining: result.remaining,
    conversationId: sent.conversationId,
  };
}
