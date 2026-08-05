// 야잘알봇 질문 서버 처리 코어. POST /api/baseball-qa(즉시 경로)와
// /api/cron/baseball-qa-drain(durable 복구 경로)이 같은 처리기를 공유한다.
// 질문 INSERT와 같은 트랜잭션에서 trigger가 만든 genius_question_jobs 행을
// claim → (idempotent quota/LLM) 파이프라인 → ready 저장 → 답변 DM → completed 순으로 진행한다.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendOpsMessageToUser } from "@/lib/cs/send-ops-message";
import {
  answerQuestion,
  BLOCKED_ANSWER,
  isAckPhrase,
  MAX_QUESTION_LEN,
  MIN_QUESTION_LEN,
  isPickedPlayerAllowed,
  type GlossaryEntry,
  type LlmResult,
  type QaDeps,
  type QaResult,
} from "@/lib/baseball-qa/pipeline";
import {
  isFollowupPhrase,
  type ContextTurn,
  type PreviousTurnRow,
} from "@/lib/baseball-qa/context";
import {
  BASEBALL_GENIUS_USER_ID,
  replyKindForMatchPath,
  type GeniusReplyPayload,
} from "@/lib/constants/baseball-genius";
import {
  loadRosterPlayers,
  ROSTER_PLAYERS,
} from "@/lib/baseball-qa/roster/load-roster-players";
import {
  BASEBALL_QA_GEMINI_MODEL,
  BASEBALL_QA_SYSTEM_PROMPT,
  buildBaseballQaGeminiRequest,
} from "@/lib/baseball-qa/gemini-request";
import {
  buildRagLlmRequest,
  RAG_CANDIDATE_LIMIT,
  RAG_DOCUMENT_CANDIDATE_LIMIT,
  RAG_OFFICIAL_SYSTEM_PROMPT,
  searchSourcePriorityCandidates,
  type RagDocumentSourceKind,
  type RagEvidence,
  type RagEvidenceCandidate,
  type RagPlayerCandidate,
} from "@/lib/baseball-qa/rag/retrieve";
import { createSeasonRecordFetcher } from "@/lib/baseball-qa/stats/fetch-season-record";
import { createServedRecordFetcher } from "@/lib/baseball-qa/stats/served-record";
import { createTeamRecordFetchers } from "@/lib/baseball-qa/stats/team-record";
import type { SeasonRecordClient } from "@/lib/baseball-qa/stats/fetch-season-record";
import { embedQuery } from "@/lib/baseball-qa/rag/embed";
import { tier2WeightForQuestion } from "@/lib/baseball-qa/rag/fetch-wikipedia";

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

/** genius_rag_serving_chunks 서빙 행 (snake_case SQL 시그니처). */
interface RagServingChunkRow {
  content: string;
  page_title: string;
  canonical_url: string;
  revision: string;
  section_path: string;
  as_of: string;
  source_grade: string;
  source_kind: RagDocumentSourceKind;
  embedding: string | number[] | null;
}

/**
 * 공식 문서 검색 RPC 반환 행.
 * 선수 경로와 달리 **embedding을 돌려받지 않는다** — 정렬을 DB가 끝내므로 앱은 벡터가 필요 없고,
 * 768차원 벡터 12개를 \uc automation으로 끌어오면 응답만 무거워진다.
 */
interface RagOfficialChunkRow {
  content: string;
  page_title: string;
  canonical_url: string;
  revision: string;
  section_path: string;
  as_of: string;
  source_grade: string;
}

/**
 * entity-filtered tier2 근거 검색.
 *
 * 서빙 뷰(genius_rag_serving_chunks)만 읽는다 — 이 뷰는 active generation chunk만 노출하므로
 * 수집 중인 미완성 snapshot이 검색에 새어나지 않는다. entity_id 등가 필터를 걸어
 * **대상 선수의 문서가 아니면 아예 후보에 들어오지 못하게** 한다(엉뚱한 chunk 답변 차단).
 * 미수집 선수는 자연히 0행이므로 호출자가 fail-close한다.
 */
export interface RagSearchRuntime {
  embed: typeof embedQuery;
  fetchBySourceKind: (
    candidate: RagPlayerCandidate,
    sourceKind: RagDocumentSourceKind,
    limit: number,
    /**
     * 질문 임베딩. **후보 선정 단계에서부터** 필요하다 — 무순서 절단을 금지하고
     * DB 가 이 벡터 기준으로 정렬한 상위 N 을 돌려주게 하기 위해 시그니처에 박는다.
     */
    queryVector: number[],
  ) => Promise<RagEvidenceCandidate[]>;
}

/** 선수(tier2) 후보 정렬 RPC 이름 — 게이트가 이 상수로 production 배선을 결속한다. */
export const RAG_PLAYER_CHUNK_SEARCH_RPC = "search_baseball_genius_player_chunks" as const;

/**
 * production RAG 후보 검색 런타임 팩토리.
 *
 * client 를 인자로 받는 이유는 테스트 전용 경로를 만들기 위해서가 아니라,
 * **게이트가 배포되는 바로 그 함수를 실행**해 "무순서 절단으로 퇴화했는지"를 행동으로
 * 판정할 수 있게 하기 위해서다. 소스 정규식 검사는 dead decoy 호출로 뚫린다.
 */
export function createProductionRagSearchRuntime(
  client: Pick<typeof supabaseAdmin, "rpc">,
): RagSearchRuntime {
  return {
    embed: embedQuery,
    fetchBySourceKind: async (candidate, sourceKind, limit, queryVector) => {
      // ⚠️ 여기서 **정렬 없이** `.from(...).limit(40)` 을 쓰면 안 된다 (2026-08-05 production 사고).
      //   문보경 나무위키 chunk 는 133건인데 무순서 40건만 받아오면 '문보물' 이 든 chunk_index 51 이
      //   후보에조차 못 들어와, 앱에서 코사인을 아무리 정확히 계산해도 복구할 수 없다.
      //   그래서 **DB(pgvector)가 질문 벡터 기준으로 정렬한 상위 N** 만 받는다.
      //   최종 근거 4건 선택과 소스 우선순위는 종전대로 앱이 하므로 embedding 도 함께 받는다.
      // query-guard: bounded -- RPC 가 1..50 으로 clamp 하는 정렬 조회이며 caller 는 RAG_CANDIDATE_LIMIT(40) 을 준다.
      const { data, error } = await client.rpc(RAG_PLAYER_CHUNK_SEARCH_RPC, {
        p_entity_type: candidate.entityType,
        p_entity_id: candidate.entityId,
        p_source_kind: sourceKind,
        p_query_embedding: JSON.stringify(queryVector),
        p_limit: limit,
      });
      if (error) throw error;
      return ((data ?? []) as RagServingChunkRow[]).map((row) => ({
        content: row.content,
        pageTitle: row.page_title,
        canonicalUrl: row.canonical_url,
        revision: row.revision,
        sectionPath: row.section_path,
        asOf: row.as_of,
        sourceGrade: row.source_grade === "tier1" ? ("tier1" as const) : ("tier2" as const),
        embedding: row.embedding,
      }));
    },
  };
}

const productionRagSearchRuntime: RagSearchRuntime = createProductionRagSearchRuntime(supabaseAdmin);

export async function searchRag(
  candidate: RagPlayerCandidate,
  question: string,
  runtime: RagSearchRuntime = productionRagSearchRuntime,
): Promise<RagEvidence[]> {
  const embedded = await runtime.embed(question);
  if (!embedded.ok) return [];
  // query-guard: bounded -- entity + source_kind 폐쇄집합 각각 최대 40행. entity 전체를
  // 먼저 limit(40)하면 Namu 41건 뒤의 Wikipedia가 DB에서 소실된다.
  // 각 source_kind 안에서도 **질문 벡터 기준 상위 40건**이어야 한다(무순서 40건 금지).
  return searchSourcePriorityCandidates(
    (sourceKind) =>
      runtime.fetchBySourceKind(candidate, sourceKind, RAG_CANDIDATE_LIMIT, embedded.vector),
    embedded.vector,
    // 순서 강제가 아니라 **질문 의도별 가중**이다(삼순 P0).
    // 별명·여담은 나무위키를, 소속·프로필은 위키피디아를 살짝 올릴 뿐 반대편을 탈락시키지 않는다.
    tier2WeightForQuestion(question),
  );
}

/** 근거를 비신뢰 데이터 블록으로만 전달하는 재서술 호출 (S2b). */
async function callRagLlm(question: string, evidence: RagEvidence[]): Promise<LlmResult> {
  return callRagLlmWithPrompt(question, evidence);
}

/** 공식 간행물(tier1) 근거 전용 호출 — 프롬프트만 다르고 경계는 동일하다. */
async function callOfficialRagLlm(question: string, evidence: RagEvidence[]): Promise<LlmResult> {
  return callRagLlmWithPrompt(question, evidence, RAG_OFFICIAL_SYSTEM_PROMPT);
}

async function callRagLlmWithPrompt(
  question: string,
  evidence: RagEvidence[],
  systemPrompt?: string,
): Promise<LlmResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      systemPrompt
        ? buildRagLlmRequest(question, evidence, systemPrompt)
        : buildRagLlmRequest(question, evidence),
    ),
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

/**
 * KBO 공식 간행물(tier1) 근거 검색 — 규칙·용어 질문용.
 *
 * 선수 경로와의 결정적 차이: **entity로 문서를 좁힐 수 없다.** "보크가 뭐야"는 어느 간행물
 * 몇 페이지에 답이 있는지 질문만으로 알 수 없으므로 공식 문서 코퍼스 전체가 후보다.
 * 그래서 앱에서 코사인을 재계산하는 선수 경로와 달리 **DB가 pgvector로 정렬해 상위 N만**
 * 돌려준다(수천 chunk를 앱으로 끌어오면 안 된다).
 *
 * 범위는 `entity_type='document'` + `source_grade='tier1'`로 이중 제한한다 — tier2 chunk가
 * 이 경로로 새면 숫자 허용 계약이 깨진다.
 */
async function searchOfficialRag(question: string): Promise<RagEvidence[]> {
  const embedded = await embedQuery(question);
  if (!embedded.ok) return [];
  // query-guard: bounded -- RPC가 RAG_DOCUMENT_CANDIDATE_LIMIT 상한을 강제하는 정렬 조회다.
  const { data, error } = await supabaseAdmin.rpc("search_baseball_genius_official_chunks", {
    p_query_embedding: JSON.stringify(embedded.vector),
    p_limit: RAG_DOCUMENT_CANDIDATE_LIMIT,
  });
  if (error) throw error;
  return ((data ?? []) as RagOfficialChunkRow[]).map((row) => ({
    content: row.content,
    pageTitle: row.page_title,
    canonicalUrl: row.canonical_url,
    revision: row.revision,
    sectionPath: row.section_path,
    asOf: row.as_of,
    // 계약상 tier1만 돌아오지만, 호출자(`allowsNumericAnswer`)가 다시 확인할 수 있게 실값을 싱는다.
    sourceGrade: row.source_grade === "tier1" ? ("tier1" as const) : ("tier2" as const),
  }));
}

/** baseball_genius_previous_turn RPC 반환 행 (snake_case SQL 시그니처). */
interface PreviousTurnRowSql {
  question: string | null;
  answer: string | null;
  job_source: string | null;
  answered_at: string | null;
  current_created_at: string | null;
}

/**
 * picker 선택을 job 행에 고정하거나, 입력이 없으면 이미 고정된 값을 읽어온다.
 *
 * 즉시 경로(/api/baseball-qa)가 약간 진행하다 브라우저가 죽으면 cron drain이 같은 job을 이어받는다.
 * 그때 drain은 유저가 무엇을 고랐는지 모른다 — DB에 남겨두지 않으면 picker가 다시 뜨면서
 * 유저 입장에선 방금 고른 것이 사라진다. 저장 실패는 진행을 막지 않고(답변 자체는 가능),
 * 다음 재처리에서 picker로 되돌아갈 뿐이다.
 */
async function persistOrLoadPickedPlayer(
  messageId: number,
  question: string,
  input?: string | null,
): Promise<string | null> {
  if (input) {
    // **서버 발급 후보군 membership** 을 먼저 재검증하고, 통과한 뒤에만 영속한다.
    // 단순히 "로스터에 존재하는 id"만 보면 원 질문 `김동현` picker에 문보경(69102)을
    // 주입해도 문보경 기록을 답하게 된다(삼순 P0-1 actual). 유저가 ID를 입력하는 구조가
    // 아니라도 클라이언트 요청은 위조 가능하므로 서버가 원 질문에서 후보군을 다시 계산한다.
    if (!isPickedPlayerAllowed(question, input, ROSTER_PLAYERS)) return null;

    const { error } = await supabaseAdmin
      .from("genius_question_jobs")
      .update({ picked_player_kbo_id: input, updated_at: new Date().toISOString() })
      .eq("message_id", messageId);
    if (error) {
      console.error("baseball-genius picked player persist failed:", error.message);
      return null;
    }
    return input;
  }
  const { data, error } = await supabaseAdmin
    .from("genius_question_jobs")
    .select("picked_player_kbo_id")
    .eq("message_id", messageId)
    .maybeSingle();
  if (error) return null;
  return (data?.picked_player_kbo_id as string | null) ?? null;
}

async function preparePickedPlayerSelection(
  messageId: number,
  userId: string,
  question: string,
  pickedPlayerKboId: string,
): Promise<boolean> {
  if (!isPickedPlayerAllowed(question, pickedPlayerKboId, ROSTER_PLAYERS)) return false;
  // query-guard: bounded -- message_id PK 한 행만 갱신하고 boolean scalar 하나를 반환한다.
  const { data, error } = await supabaseAdmin.rpc("prepare_baseball_genius_player_selection", {
    p_message_id: messageId,
    p_user_id: userId,
    p_picked_player_kbo_id: pickedPlayerKboId,
  });
  if (error) throw error;
  return data === true;
}

/** messageId에 바인딩된 deps — quota/LLM을 job 행 기준 durable idempotent로 만든다. */
export function makeDeps(messageId: number, pickedPlayerKboId?: string | null): QaDeps {
  return {
    loadGlossary,
    // 인라인 loader 대신 seam 을 그대로 주입한다 — 게이트가 실제 배포 함수를 실행해
    // 로스터가 끊기는 변종을 RED 로 잡는다(삼순 8차 P0-2).
    loadPlayers: loadRosterPlayers,
    callLlm,
    searchRag,
    callRagLlm,
    // 선수 서술형 RAG 개통 (하린아빠 2026-08-03: "RAG을 확장했기 때문에 '문보경 별명이 뭐야?'도
    // 답변 되어야 해"). 미수집 선수는 근거 0행이라 그대로 fail-close 된다 — 없는 말을 지어내지 않는다.
    enablePlayerRag: true,
    pickedPlayerKboId: pickedPlayerKboId ?? null,
    releaseDaily: async (userId) => {
      // query-guard: bounded -- message_id 단위 멱등 단일 행 갱신 RPC.
      const { error } = await supabaseAdmin
        .rpc("release_baseball_genius_daily_question_for_message", {
          p_message_id: messageId,
          p_user_id: userId,
        });
      if (error) throw error;
    },
    /**
     * 시즌 기록 조회 (kbo_structured). **player_key=kboId exact** 로만 본다 — 이름 조회는 동명이인을
     * 섞어버리므로 금지다(삼순 조건 ①). 상한 2로 조회해서 중복행을 숨기지 않고
     * 호출부가 `inconsistent` 로 fail-close 할 수 있게 한다.
     */
    // 인라인 lambda 대신 seam factory를 쓴다 — 테스트가 이 같은 함수를 그대로 실행해
    // table/kboId/row 전달을 actual 검증한다(정규식만 보는 false-green 제거, 삼순 3차 P0-3).
    fetchSeasonRecord: createSeasonRecordFetcher(
      supabaseAdmin as unknown as SeasonRecordClient,
    ),
    /**
     * 도루·출루율·장타율·OPS 조회. `player_stats_batter` 에는 이 컬럼이 없다.
     * 정본은 **앱이 실제로 서빙하는 `/api/stats` 응답**이다 — static JSON 이 아니다
     * (삼순 3차 P0-3: `/api/stats` 는 static 위에 live Runner map 을 덮어쓴다).
     * 여기도 인라인 lambda 대신 seam factory 를 쓴다(게이트가 실제 배포 함수를 실행).
     */
    fetchServedRecord: createServedRecordFetcher(),
    /**
     * 구단 기록 조회 — `/api/standings` · `/api/team-records`.
     *
     * 종전에는 구단 수치 질문을 고정 안내문으로 닫았는데, 그 근거("팀 집계 정본이 없다")가
     * 틀렸다 — 앱 순위탭·팀기록탭이 이미 그 값을 서빙한다(하린아빠 2026-08-04 20:42).
     * 여기도 인라인 lambda 대신 seam factory 를 쓴다(게이트가 실제 배포 함수를 실행).
     */
    fetchTeamRecord: createTeamRecordFetchers(),
    searchOfficialRag,
    callOfficialRagLlm,
    recordRagDemand: async (sourceKeys) => {
      // query-guard: bounded -- RPC가 source_keys 상한(20)을 강제하는 단일 갱신이다.
      const { error } = await supabaseAdmin
        .rpc("record_baseball_genius_source_demand", { p_source_keys: sourceKeys });
      if (error) throw error;
    },
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
  /**
   * 동명이인 picker에서 유저가 고른 kboId (재질의). 즉시 경로(route)에서만 전달되며,
   * job 행에 고정되어 cron drain 재처리에서도 같은 선수로 이어진다.
   */
  pickedPlayerKboId?: string | null;
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

  if (input.pickedPlayerKboId) {
    try {
      const prepared = await preparePickedPlayerSelection(
        messageId, userId, question, input.pickedPlayerKboId,
      );
      if (!prepared) {
        return { kind: "failed", status: 400, reason: "선택한 선수를 확인할 수 없습니다" };
      }
    } catch (error) {
      console.error("baseball-genius player selection failed:", (error as Error).message);
      return { kind: "failed", status: 503, reason: "선수 선택을 저장할 수 없습니다" };
    }
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
      .select("answer, source, remaining, picker_options, picker_question_message_id")
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
      ...(Array.isArray(readyJob.picker_options)
        ? { pickerOptions: readyJob.picker_options as NonNullable<QaResult["pickerOptions"]> }
        : {}),
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
        // 선택은 job 행을 SSOT로 삼는다. 즉시 경로가 죽어 cron이 이어받아도 유저가 고른
        // 그 선수로 답하도록, 입력이 있으면 먼저 고정하고 없으면 저장된 값을 읽는다.
        const picked = await persistOrLoadPickedPlayer(messageId, question, input.pickedPlayerKboId);
        result = await answerQuestion(userId, question, makeDeps(messageId, picked));
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
          picker_options: result.pickerOptions ?? null,
          picker_question_message_id: result.pickerOptions ? messageId : null,
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", messageId)
        .eq("status", "processing");
      if (readyError) throw readyError;
    } catch (error) {
      console.error("baseball-genius pipeline failed:", (error as Error).message);
      result = { status: 200, answer: BLOCKED_ANSWER, source: "error", remaining: 0 };
      const { error: fallbackError } = await supabaseAdmin
        .from("genius_question_jobs")
        .update({
          status: "ready",
          answer: result.answer,
          source: result.source,
          remaining: result.remaining,
          last_error: "pipeline_fallback",
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", messageId)
        .eq("status", "processing");
      if (fallbackError) {
        return { kind: "failed", status: 503, reason: "답변 fallback 저장에 실패했습니다" };
      }
    }
  }

  // 답변 유형을 payload 에 함께 저장한다 — 클라가 유형별 마스코트를 고를 근거(SSOT).
  // 클라가 답변 문구를 상수와 대조하는 방식은 문구를 고치는 순간 조용히 깨진다.
  const replyPayload: GeniusReplyPayload = {
    type: "baseball_genius_reply",
    reply_kind: replyKindForMatchPath(result.source),
    match_path: result.source,
    // 동명이인 되물기일 때만 선택지를 실는다. 클라는 이걸 보고 카드를 렌더한다.
    ...(result.pickerOptions
      ? {
        question_message_id: messageId,
        picker_options: result.pickerOptions.map((option) => ({
          kbo_id: option.kboId,
          name: option.name,
          team: option.team,
          position: option.position,
          back_no: option.backNo,
        })),
      }
      : {}),
    // 근거 문서 링크. 본문에는 `📄 출처: 나무위키` 표시명만 있고 클라가 여기에 앵커를 씌운다.
    // 내부 메타(revision·crawledAt·asOf)는 절대 payload 에 싣지 않는다 — 유저가 볼 이유가 없고
    // `crawled` 는 수집 사실을 화면에 적는 것이라 위험하다 (하린아빠 2026-08-05 P0).
    ...(result.sourceUrl ? { source_url: result.sourceUrl } : {}),
  };
  const deliveryDedupKey = result.source === "player_picker"
    ? `baseball-genius-picker:${messageId}`
    : dedupKey;
  const sent = await sendOpsMessageToUser(
    supabaseAdmin,
    BASEBALL_GENIUS_USER_ID,
    userId,
    result.answer,
    deliveryDedupKey,
    "dm",
    replyPayload,
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
    .update({
      status: result.source === "player_picker" ? "awaiting_selection" : "completed",
      updated_at: new Date().toISOString(),
    })
    .eq("message_id", messageId);
  return {
    kind: "completed",
    source: result.source,
    remaining: result.remaining,
    conversationId: sent.conversationId,
  };
}
