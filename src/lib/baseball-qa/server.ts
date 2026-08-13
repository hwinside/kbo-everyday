// 야잘알봇 질문 서버 처리 코어. POST /api/baseball-qa(즉시 경로)와
// /api/cron/baseball-qa-drain(durable 복구 경로)이 같은 처리기를 공유한다.
// 질문 INSERT와 같은 트랜잭션에서 trigger가 만든 genius_question_jobs 행을
// claim → (idempotent quota/LLM) 파이프라인 → ready 저장 → 답변 DM → completed 순으로 진행한다.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildQuestionLogRow } from "@/lib/baseball-qa/log-row";
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
  type RagLlmExtras,
} from "@/lib/baseball-qa/pipeline";
import type { TodayGameStarters } from "@/lib/baseball-qa/pipeline";
import { adaptTodayStarters } from "@/lib/baseball-qa/pipeline";
import { fetchGamesUserFacingWithMeta } from "@/lib/crawler/games-user-facing";
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
  RAG_SYSTEM_PROMPT,
  RAG_CANDIDATE_LIMIT,
  RAG_DOCUMENT_CANDIDATE_LIMIT,
  RAG_NEWS_CANDIDATE_LIMIT,
  RAG_NEWS_SYSTEM_PROMPT,
  RAG_OFFICIAL_SYSTEM_PROMPT,
  RAG_TEAM_SYSTEM_PROMPT,
  searchSourcePriorityCandidates,
  type RagDocumentSourceKind,
  type RagEntityCandidate,
  type RagEvidence,
  type RagEvidenceCandidate,
  type RagNewsCandidate,
} from "@/lib/baseball-qa/rag/retrieve";
import type { RagSourceKind } from "@/lib/baseball-qa/rag/contracts";
import { createSeasonRecordFetcher } from "@/lib/baseball-qa/stats/fetch-season-record";
import { createServedRecordFetcher } from "@/lib/baseball-qa/stats/served-record";
import { createCareerRecordFetcher } from "@/lib/baseball-qa/stats/career-series";
import { createCareerLeaderboardFetcher } from "@/lib/baseball-qa/stats/career-leaderboard";
import { createCareerMetricLeaderboardFetcher } from "@/lib/baseball-qa/stats/career-metric-leaderboard";
import careerMetricBaseline from "@/../data/baseball-qa/kbo-career-metrics-through-2025.json";
import { fetchServedCareerSnapshot } from "@/lib/baseball-qa/stats/served-record";
import { createSeriesPrizeHtmlFetcher } from "@/lib/baseball-qa/awards/series-prize";
import { createTeamRecordFetchers } from "@/lib/baseball-qa/stats/team-record";
import type { SeasonRecordClient } from "@/lib/baseball-qa/stats/fetch-season-record";
import { embedQuery } from "@/lib/baseball-qa/rag/embed";
import { tier2WeightForQuestion } from "@/lib/baseball-qa/rag/fetch-wikipedia";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * 구단 RAG kill-switch.
 *
 * ⚠️ 왜 필요한가 (삼순 2026-08-07 12라운드): tier2 숫자 가드는 **best-effort** 정책으로
 *   간다(하린아빠 승인). 즉 잔존 누수가 있을 수 있고, 그게 실제로 유저에게 보이면
 *   **빠르게 끌 수 있어야** 한다. 종전처럼 `enableTeamRag: true` 로 하드코딩하면
 *   끄는 데 코드 수정 → 리뷰 → 머지 → 배포가 필요해 대응이 늦는다.
 *
 * 끄는 법: Vercel 환경변수 `TEAM_RAG_DISABLED=1` 설정 → **재배포 1회**(~2분).
 *
 *   ⚠️ "재배포 없이 즉시"가 아니다(삼순 2026-08-07 정정, 내가 틀리게 썼던 부분).
 *     Vercel env 변경은 **기존 배포에 반영되지 않는다** — 각 배포가 빌드 시점의 env 를
 *     들고 있기 때문이다. 콜드스타트가 다시 읽어 갈 것이라는 내 설명은 사실이 아니었다.
 *     그러니 이건 *즉시 스위치*가 아니라 **재배포형 rapid rollback**이다:
 *     코드 수정·리뷰·머지를 건너뛰고 재배포만으로 끄는 것이 이 스위치의 값어치다.
 *
 *   무배포 즉시 차단이 필요하다면 DB/원격 런타임 플래그가 필요한데, 그건 답변 경로마다
 *   조회가 하나 더 붙는 비용이라 별도 판단 사항으로 남긴다.
 *
 *   끄면 구단 질문은 종전 경로(일반 LLM)로 내려간다 — 기능이 죽는 게 아니라 RAG 만 우회한다.
 *
 * ⚠️ **fail-safe 방향**: 값이 없거나 이상하면 **켜진 상태**를 유지한다. 이 스위치는
 *   장애 대응용이지 기능 게이트가 아니므로, 오타 하나로 조용히 꺼지면 안 된다.
 *   끄는 것은 명시적인 `1`/`true`/`yes`/`on` 일 때만이다.
 */
export function teamRagEnabled(): boolean {
  const raw = (process.env.TEAM_RAG_DISABLED ?? "").trim().toLowerCase();
  return !["1", "true", "yes", "on"].includes(raw);
}
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

// 실-provider 게이트(genius-question-normalize-live)가 파이프라인과 같은 입력으로 판정하도록 export.
export async function loadGlossary(): Promise<GlossaryEntry[]> {
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

async function callLlm(
  question: string,
  context?: ContextTurn,
  rosterBlock?: string,
): Promise<LlmResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildBaseballQaGeminiRequest(question, SYSTEM_PROMPT, context, rosterBlock)),
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
 * 검수 사전 정의 질문 매핑 (C 질문 정규화 — pipeline `mapGlossaryDefinition` seam 구현).
 *
 * 입력 후보는 파이프라인이 결정론으로 추출한 "질문에 실제로 들어있는 사전 용어"뿐이고,
 * 출력은 그 폐쇄집합 안의 term 하나 또는 null 이다. 호출부(pipeline)가 후보 밖 반환을
 * 버리므로(fail-close) 모델 오판의 최대 피해는 "검수된 정의문이 불필요한 질문에 나감"이다.
 * 생성문이 유저에게 나가는 경로는 없다 — 서빙되는 답은 항상 사람이 검수한 사전 answer 다.
 */
export async function mapGlossaryDefinition(
  question: string,
  candidateTerms: string[],
): Promise<{ term: string | null; inputTokens: number | null; outputTokens: number | null }> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const systemPrompt = [
    "너는 KBO 야구 용어 사전의 질문 분류기다.",
    "아래 후보 용어 목록 중, 사용자의 질문이 **그 용어 자체의 뜻·정의**를 묻는 것일 때만 그 용어를 고른다.",
    "다음은 정의 질문이 아니므로 반드시 null 이다:",
    "· 용어를 적용한 결과·규칙 질문 (예: 보크하면 주자 몇 루 가? — 보크의 뜻이 아니라 결과를 묻는다)",
    "· 두 용어의 비교·차이 질문 (예: 유격수와 2루수 차이가 뭐야? — 한 용어의 정의문으로 답할 수 없다)",
    "· 특정 선수·구단의 기록 수치나 오늘·특정 경기의 조회 질문 (예: 오늘 유격수 누구야?)",
    "· 용어가 문장에 스쳐 지나갈 뿐인 질문",
    "확실하지 않으면 null 을 고른다 — 정의문을 잘못 주는 쪽이 안 주는 쪽보다 나쁘다.",
    '반드시 JSON 하나만 출력한다: {"term":"후보 목록에 있는 용어 그대로"} 또는 {"term":null}',
  ].join("\n");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{
        role: "user",
        parts: [{ text: `후보 용어: ${JSON.stringify(candidateTerms)}\n질문: ${question}` }],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 64,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Gemini API failed: ${res.status}`);
  const data = await res.json();
  // 관측 계약 (삼순 2026-08-11 ④축): 매퍼도 LLM 호출이다 — 토큰을 파이프라인으로 돌려
  // 로그에 기록되게 한다(매핑 성공 시 그 행에, 실패 시 후속 경로 행에 합산).
  const inputTokens: number | null = data.usageMetadata?.promptTokenCount ?? null;
  const outputTokens: number | null = data.usageMetadata?.candidatesTokenCount ?? null;
  const text: string =
    data.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // malformed 는 매핑 실패 — 기존 경로로 양보한다 (#1142 malformed fail-close 계약과 동일 축).
    return { term: null, inputTokens, outputTokens };
  }
  const term = (parsed as { term?: unknown })?.term;
  return {
    term: typeof term === "string" && term.length > 0 ? term : null,
    inputTokens,
    outputTokens,
  };
}

/**
 * 질문 1차 LLM 정규화 (pipeline `normalizeQuestionLlm` seam 구현, 2026-08-11).
 *
 * 표기 교정만 한다 — 띄어쓰기·명백한 오탈자·붙여 쓴 단어 분리. 의미 변경·단어 대체·숫자
 * 변경은 프롬프트로 금지하고, 수용 여부는 어차피 호출부(pipeline)의 폐쇄 가드
 * (숫자 시퀀스 보존·길이 상한·재라우팅 non-blocked)가 다시 강제한다.
 * malformed·장애·null 은 전부 "교정 없음"으로 수렴한다(fail-open — 원문 진행).
 */
export async function normalizeQuestionLlm(
  question: string,
): Promise<{ text: string | null; inputTokens: number | null; outputTokens: number | null }> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const systemPrompt = [
    "너는 KBO 야구 서비스에 들어온 사용자 질문의 표기 교정기다.",
    "질문의 의미는 절대 바꾸지 말고 **표기만** 교정한다: 띄어쓰기, 명백한 오탈자, 붙여 쓴 단어 분리.",
    "다음은 금지다:",
    "· 단어 추가·삭제·다른 단어로 대체 (표기 교정이 아닌 바꿔쓰기)",
    "· 숫자 변경",
    "· 질문을 답변이나 설명으로 바꾸는 것",
    "· 확신 없는 사람 이름 교정 — 이름은 명백한 오타일 때만 고친다",
    "교정할 것이 없거나 확신이 없으면 null 을 준다 — 잘못 고치는 쪽이 안 고치는 쪽보다 나쁘다.",
    '반드시 JSON 하나만 출력한다: {"normalized":"교정한 질문"} 또는 {"normalized":null}',
  ].join("\n");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: `질문: ${question}` }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 128,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Gemini API failed: ${res.status}`);
  const data = await res.json();
  const inputTokens: number | null = data.usageMetadata?.promptTokenCount ?? null;
  const outputTokens: number | null = data.usageMetadata?.candidatesTokenCount ?? null;
  const text: string =
    data.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // malformed 는 교정 없음 — 원문 진행 (#1142 malformed fail-close 계약과 같은 축).
    return { text: null, inputTokens, outputTokens };
  }
  const normalized = (parsed as { normalized?: unknown })?.normalized;
  return {
    text: typeof normalized === "string" && normalized.trim().length > 0 ? normalized.trim() : null,
    inputTokens,
    outputTokens,
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
  /** RPC 가 아직 안 돌려줄 수 있으므로 optional. 없으면 sanitizer 가 URL 로 판정한다. */
  source_kind?: string;
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
    candidate: RagEntityCandidate,
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
        // ⚠️ `sanitizeEvidenceContent` 가 **나무위키 전용 정제를 이 값으로 한정**한다.
        //   여기서 빠뜨리면 정제가 URL 추정으로 내려가고, 판정 불가 시 무변조가 되어
        //   나무위키 광고가 근거로 살아난다(삼순 2026-08-07 9라운드 지적).
        sourceKind: row.source_kind,
        embedding: row.embedding,
      }));
    },
  };
}

const productionRagSearchRuntime: RagSearchRuntime = createProductionRagSearchRuntime(supabaseAdmin);

export async function searchRag(
  candidate: RagEntityCandidate,
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
async function callRagLlm(
  question: string,
  evidence: RagEvidence[],
  extras?: RagLlmExtras,
): Promise<LlmResult> {
  return callRagLlmWithPrompt(question, evidence, undefined, extras);
}

/** 공식 간행물(tier1) 근거 전용 호출 — 프롬프트만 다르고 경계는 동일하다. */
async function callOfficialRagLlm(question: string, evidence: RagEvidence[]): Promise<LlmResult> {
  return callRagLlmWithPrompt(question, evidence, RAG_OFFICIAL_SYSTEM_PROMPT);
}

/**
 * 구단(tier2) 근거 전용 호출 — 프롬프트만 다르고 경계는 선수·공식 경로와 동일하다.
 *
 * 선수용 프롬프트를 재사용하지 않는다 — "선수 소개 도우미"로 자기규정한 모델은
 * 구단 질문을 범위 밖으로 오판하고, 숫자 전면금지라 연도가 들어간 구단 서사를 전부 거부한다.
 */
async function callTeamRagLlm(
  question: string,
  evidence: RagEvidence[],
  extras?: RagLlmExtras,
): Promise<LlmResult> {
  return callRagLlmWithPrompt(question, evidence, RAG_TEAM_SYSTEM_PROMPT, extras);
}

/**
 * KBO 공식 당일 1군 등록 명단 (`roster_snapshots` 최신 snapshot_date).
 * 1군 명단 SSOT (삼순 2026-08-10) — `players-roster.json`(현재 소속 SSOT)과 분리.
 * 실패·빈 결과는 null — 파이프라인이 전체 등록 명단 + "1군 구분 불가" 고지로 fail-close.
 */
/**
 * 오늘 경기별 선발 매치업 — `/api/games` 와 같은 소스(fetchGamesUserFacing)를 직접 호출한다.
 * HTTP 자기호출이 아니라 같은 함수다 — 라우트 캐시·배포 경계에 의존하지 않는다.
 * 실패는 throw 로 올린다 — 파이프라인이 "경기 없음"과 구분해 fail-close 한다.
 */
async function fetchTodayStarters(dateYyyymmdd: string): Promise<TodayGameStarters[]> {
  const { games, kboGameIds } = await fetchGamesUserFacingWithMeta(dateYyyymmdd);
  return adaptTodayStarters(games, kboGameIds);
}

async function fetchTeamEntry(
  teamId: number,
): Promise<{ snapshotDate: string; players: string[] } | null> {
  // query-guard: bounded -- 최신 snapshot_date 1행
  const { data: latest, error: latestError } = await supabaseAdmin
    .from("roster_snapshots")
    .select("snapshot_date")
    .eq("team_id", teamId)
    .order("snapshot_date", { ascending: false })
    .limit(1);
  if (latestError || !latest?.[0]?.snapshot_date) return null;
  const snapshotDate = latest[0].snapshot_date as string;
  // query-guard: bounded -- 당일 1군 엔트리는 팀당 최대 30여 명이다 (상한 60)
  const { data: rows, error: rowsError } = await supabaseAdmin
    .from("roster_snapshots")
    .select("player_name")
    .eq("team_id", teamId)
    .eq("snapshot_date", snapshotDate)
    .limit(60);
  if (rowsError || !rows || rows.length === 0) return null;
  return { snapshotDate, players: rows.map((row) => row.player_name as string) };
}

async function callRagLlmWithPrompt(
  question: string,
  evidence: RagEvidence[],
  systemPrompt?: string,
  extras?: RagLlmExtras,
): Promise<LlmResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      buildRagLlmRequest(
        question,
        evidence,
        systemPrompt ?? RAG_SYSTEM_PROMPT,
        { context: extras?.context, rosterBlock: extras?.rosterBlock },
      ),
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
    // 공식 문서는 나무위키가 아니므로 정제 대상이 아니다. RPC 가 값을 주면 그대로 쓰고,
    // 안 주면 `kbo_ebook` 으로 고정한다 — 이 RPC 는 공식 e북만 반환하는 경로다.
    sourceKind: (row.source_kind as RagSourceKind | undefined) ?? "kbo_ebook",
  }));
}

/** `search_baseball_genius_news_articles` RPC 반환 행 (snake_case SQL 시그니처). */
interface RagNewsArticleRow {
  article_key: string;
  team_ids: number[];
  title: string;
  description: string;
  content: string;
  link: string;
  original_link: string;
  press_host: string | null;
  published_at: string;
}

/**
 * 최근 30일 구단 기사(tier2) 근거 검색 — "어제 무슨 일 있었어?" 용.
 *
 * 구단 문서 경로와 다른 점
 *  ① **시간 창이 검색 술어의 일부**다. `p_published_after` 로 하한을 DB 에 넘기고,
 *    상한(`until`)은 앱에서 걱러낸다 — RPC 가 하한만 받기 때문이다. 상한을 생략하면
 *    `그저께` 에 어제·오늘 기사가 섞여 들어온다.
 *  ② chunk 가 아니라 **기사 1건 = 근거 1건**이다. `pageTitle` 은 기사 제목,
 *    `sectionPath` 는 발행일로 채워 프롬프트 자료 블록이 시점을 갖도록 한다.
 *  ③ 정렬은 DB 가 pgvector 로 한다(공식 문서 경로와 동일). 앱은 재정렬하지 않는다 —
 *    구단 문서처럼 소스가 여럿이 아니라 가중치를 줄 대상이 없다.
 */
async function searchNewsRag(
  candidate: RagNewsCandidate,
  question: string,
): Promise<RagEvidence[]> {
  const embedded = await embedQuery(question);
  // ⚠️ 임베딩 실패를 빈 배열로 둘돔하지 않는다. 빈 배열은 파이프라인에서 "그날 기사 없음"으로
  //   해석되는데, 실제로는 재시도 가능한 실패다. 둘을 섮으면 장애가 조용히 "기사 없음" 으로 보인다.
  if (!embedded.ok) throw new Error("news rag: query embedding failed");
  // query-guard: bounded -- RPC 가 p_limit 상한(50)을 강제하는 정렬 조회다.
  const { data, error } = await supabaseAdmin.rpc("search_baseball_genius_news_articles", {
    p_team_ids: [candidate.teamId],
    p_query_embedding: JSON.stringify(embedded.vector),
    p_limit: RAG_NEWS_CANDIDATE_LIMIT,
    p_published_after: candidate.since.toISOString(),
  });
  if (error) throw error;
  const untilMs = candidate.until.getTime();
  return ((data ?? []) as RagNewsArticleRow[])
    // 상한은 반열린 구간 [since, until) 이다 — 자정에 걸친 기사가 두 날에 동시에 속하지 않게.
    .filter((row) => {
      const publishedMs = Date.parse(row.published_at);
      // 파싱 불가는 버린다 — 시점을 모르는 기사는 "어제" 근거가 될 수 없다.
      return Number.isFinite(publishedMs) && publishedMs < untilMs;
    })
    .map((row) => ({
      content: row.content,
      pageTitle: row.title,
      // 유저 노출 출처는 네이버 재송고 링크(`link`)다. 언론사 원문(`original_link`)은
      // 호스트가 수백 개라 allowlist 폐쇄집합을 만들 수 없어 쓰지 않는다.
      canonicalUrl: row.link,
      // 기사는 rev 개념이 없다. 불변 식별자인 article_key 를 쓴다(감사·중복제거용 내부 메타).
      revision: `article:${row.article_key}`,
      // 프롬프트 자료 블록에 그대로 들어가는 값이라 **발행일**을 넣는다 —
      // 모델이 여러 기사를 봄 때 언제 일인지 구분할 수 있게.
      sectionPath: row.published_at.slice(0, 10),
      asOf: row.published_at,
      // 언론 기사는 수치 정본이 아니다 — tier2 고정(migration 계약 1).
      sourceGrade: "tier2" as const,
      // 나무위키 크롬/광고 정제가 기사 발췌에 적용되면 안 된다. 소스를 명시해 정제 범위를 닫는다.
      sourceKind: "news_article" as RagSourceKind,
    }));
}

/**
 * 기사(tier2) 근거 전용 호출 — 프롬프트만 다르고 경계는 선수·구단·공식 경로와 동일하다.
 *
 * ⚠️ 구단 문서 프롬프트(`RAG_TEAM_SYSTEM_PROMPT`)를 재사용하지 않는다. 그쪽은 자기를
 * "구단 소개 도우미"로 규정해 사건·경기 서술을 범위 밖으로 오판하고, 기사 발췌이 잘려 있다는
 * 사실도 모른다(잘린 문장을 자기 지식으로 이어붙일 수 있다).
 */
async function callNewsRagLlm(question: string, evidence: RagEvidence[]): Promise<LlmResult> {
  return callRagLlmWithPrompt(question, evidence, RAG_NEWS_SYSTEM_PROMPT);
}

/**
 * 최근 기사 RAG kill-switch — 구단 RAG(`TEAM_RAG_DISABLED`)과 동일한 fail-safe 방향.
 *
 * 끄는 법: Vercel 환경변수 `NEWS_RAG_DISABLED=1` → **재배포 1회**. 즉시 스위치가 아니라
 * 코드 수정·리뷰·머지를 건너뛰는 rapid rollback 이다(Vercel env 는 기존 배포에 반영되지 않는다).
 * 끄면 최신 질문은 종전 경로(team_rag → generic LLM)로 내려간다.
 */
export function newsRagEnabled(): boolean {
  const raw = (process.env.NEWS_RAG_DISABLED ?? "").trim().toLowerCase();
  return !["1", "true", "yes", "on"].includes(raw);
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

/**
 * 교정 제안 응답(선택 또는 거절)을 job 행에 원자로 고정하고 최종 답변용 quota 예약을 다시 열다.
 *
 * `pickedNormalizedQuestion === null` 이면 거절(원문 진행)이다. 둘 다 **같은 RPC** 를 쓰는
 * 이유는 quota 재예약·attempts 리셋·`awaiting_selection` 해제 계약이 동일하기 때문이다 —
 * 둘로 나누면 한쪽만 고치는 사고가 난다.
 */
async function prepareQuestionCorrectionSelection(
  messageId: number, userId: string, pickedNormalizedQuestion: string | null,
): Promise<boolean> {
  // query-guard: bounded -- message_id PK 한 행만 갱신하고 boolean scalar 하나를 반환한다.
  const { data, error } = await supabaseAdmin.rpc("prepare_baseball_genius_question_correction", {
    p_message_id: messageId,
    p_user_id: userId,
    p_picked_normalized_question: pickedNormalizedQuestion,
  });
  if (error) throw error;
  return data === true;
}

/** messageId에 바인딩된 deps — quota/LLM을 job 행 기준 durable idempotent로 만든다. */
export function makeDeps(
  messageId: number,
  pickedPlayerKboId?: string | null,
  pickedNormalizedQuestion?: string | null,
  correctionDeclined?: boolean,
): QaDeps {
  return {
    loadGlossary,
    // 인라인 loader 대신 seam 을 그대로 주입한다 — 게이트가 실제 배포 함수를 실행해
    // 로스터가 끊기는 변종을 RED 로 잡는다(삼순 8차 P0-2).
    loadPlayers: loadRosterPlayers,
    callLlm,
    // C 질문 정규화 (2026-08-11): 사전 exact 매칭이 잉여어로 놓친 정의 질문을
    // 폐쇄집합 후보 + LLM 의도판정으로 사전 답변에 결속한다. 후보 밖 반환은 pipeline 이 버린다.
    mapGlossaryDefinition,
    // 질문 1차 LLM 정규화 (2026-08-11): residual 질문만 표기 교정 후 재라우팅한다.
    // 수용 가드(숫자 보존·길이·non-blocked)는 pipeline 이 강제한다.
    normalizeQuestionLlm,
    pickedNormalizedQuestion: pickedNormalizedQuestion ?? null,
    correctionDeclined: correctionDeclined === true,
    searchRag,
    callRagLlm,
    // 선수 서술형 RAG 개통 (하린아빠 2026-08-03: "RAG을 확장했기 때문에 '문보경 별명이 뭐야?'도
    // 답변 되어야 해"). 미수집 선수는 근거 0행이라 그대로 fail-close 된다 — 없는 말을 지어내지 않는다.
    enablePlayerRag: true,
    // 구단 RAG 개통 (하린아빠 2026-08-05 "배선 연결"). production 적재 실측:
    // `genius_rag_sources` team 10/10 ready, `genius_rag_serving_chunks` entity_type=team 71,531건.
    // 그런데 후보 생성 코드가 없어 한 건도 읽히지 않고 있었다(`LG 역사` → source=llm).
    enableTeamRag: teamRagEnabled(),
    callTeamRagLlm,
    fetchTeamEntry,
    // 오늘 선발 매치업 (2026-08-11 ① A안) — 앱이 이미 서빙하는 경기 데이터 그대로, LLM·RAG·cache 0.
    fetchTodayStarters,
    // 최근 기사 RAG 개통. production 적재 실측(2026-08-08 14일 백필):
    // `genius_news_articles` 2,438행 · embedding 2,438/2,438 · 서빙뷰 2,438건 · 커버리지 140/140칸 ok.
    // 적재만 되고 조회 배선이 없으면 근거는 사장된다(#1110 구단 RAG 에서 이미 겪은 사고).
    enableNewsRag: newsRagEnabled(),
    searchNewsRag,
    callNewsRagLlm,
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
     * 연도별·통산·과거 시즌 — KBO 공식 선수 상세 `Total.aspx` (2026-08-10 캐처:
     * `최형우 연도별 타율 추이`가 올해 단일값으로 오답). 공식 구조화 테이블 조회라
     * draft `lblDraft` 와 같은 축 — 여기도 seam factory(게이트가 실제 배포 함수 실행).
     */
    fetchCareerRecord: createCareerRecordFetcher(),
    /** 리그 통산 순위 — 2025년 말 공식 기준선 + 앱의 2026 최종 스냅샷. */
    fetchCareerLeaderboard: createCareerLeaderboardFetcher(),
    /**
     * 리그 통산 **다지표** 순위 — 위와 같은 계약(2025년 말 공식 기준선 + 앱의 당해 시즌 증분)을
     * 타자 15지표·투수 12지표로 넓힌 것. 지표가 늘어도 판정 분기는 늘지 않는다(카탈로그 SSOT).
     */
    fetchCareerMetricLeaderboard: createCareerMetricLeaderboardFetcher(
      () => careerMetricBaseline,
      fetchServedCareerSnapshot,
    ),
    /**
     * 구단 기록 조회 — `/api/standings` · `/api/team-records`.
     *
     * 종전에는 구단 수치 질문을 고정 안내문으로 닫았는데, 그 근거("팀 집계 정본이 없다")가
     * 틀렸다 — 앱 순위탭·팀기록탭이 이미 그 값을 서빙한다(하린아빠 2026-08-04 20:42).
     * 여기도 인라인 lambda 대신 seam factory 를 쓴다(게이트가 실제 배포 함수를 실행).
     */
    fetchTeamRecord: createTeamRecordFetchers(),
    /**
     * 한국시리즈 MVP 수상 정본 (`SeriesPrize.aspx`). 우승 기여·KS MVP 질문은
     * generic LLM 위임 금지 축(삼순 2026-08-10) — 정본 조회로만 답한다.
     */
    fetchSeriesPrizeHtml: createSeriesPrizeHtmlFetcher(),
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
      const { error } = await supabaseAdmin
        .from("genius_question_logs")
        .insert(buildQuestionLogRow(entry, messageId));
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
  /** 교정 카드에서 유저가 고른 서버 발급 exact 후보. */
  pickedNormalizedQuestion?: string | null;
  /** 교정 제안을 거절하고 원문 그대로 답변받겠다고 한 경우. */
  declineCorrection?: boolean;
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

  let persistedCorrection: string | null = input.pickedNormalizedQuestion ?? null;
  if (!persistedCorrection && input.pickedPlayerKboId) {
    const { data: correctionJob, error: correctionError } = await supabaseAdmin
      .from("genius_question_jobs")
      .select("picked_normalized_question")
      .eq("message_id", messageId)
      .maybeSingle();
    if (correctionError) return { kind: "failed", status: 503, reason: "교정 질문을 확인할 수 없습니다" };
    persistedCorrection = correctionJob?.picked_normalized_question as string | null ?? null;
  }
  const effectiveQuestionForPlayerPick = persistedCorrection ?? question;

  // 선택과 거절을 **동시에** 받으면 어느 쪽을 따를지 모른다 — 입력단에서 fail-close 한다.
  if (input.pickedNormalizedQuestion && input.declineCorrection) {
    return { kind: "failed", status: 400, reason: "교정 응답이 모호합니다" };
  }

  if (input.pickedPlayerKboId) {
    try {
      const prepared = await preparePickedPlayerSelection(
        messageId, userId, effectiveQuestionForPlayerPick, input.pickedPlayerKboId,
      );
      if (!prepared) {
        return { kind: "failed", status: 400, reason: "선택한 선수를 확인할 수 없습니다" };
      }
    } catch (error) {
      console.error("baseball-genius player selection failed:", (error as Error).message);
      return { kind: "failed", status: 503, reason: "선수 선택을 저장할 수 없습니다" };
    }
  }

  if (input.pickedNormalizedQuestion || input.declineCorrection) {
    try {
      const prepared = await prepareQuestionCorrectionSelection(
        messageId, userId, input.pickedNormalizedQuestion ?? null,
      );
      if (!prepared) return { kind: "failed", status: 400, reason: "선택한 교정 질문을 확인할 수 없습니다" };
    } catch (error) {
      console.error("baseball-genius question correction selection failed:", (error as Error).message);
      return { kind: "failed", status: 503, reason: "교정 질문 선택을 저장할 수 없습니다" };
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
      .select("answer, source, remaining, picker_options, picker_question_message_id, correction_options, picked_normalized_question")
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
      ...(Array.isArray(readyJob.correction_options)
        ? { correctionOptions: readyJob.correction_options as string[] }
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
        const picked = await persistOrLoadPickedPlayer(
          messageId, persistedCorrection ?? question, input.pickedPlayerKboId,
        );
        // 선택·거절 둘 다 job 행이 SSOT 다 — 즉시 경로가 죽어 cron drain 이 이어받아도 같은
        // 결정으로 답하고, 거절된 질문이 정규화를 다시 타 같은 카드를 또 내지 않는다.
        let selectedCorrection = persistedCorrection;
        let declined = input.declineCorrection === true;
        if (!selectedCorrection || !declined) {
          const { data: correctionJob, error: correctionError } = await supabaseAdmin
            .from("genius_question_jobs")
            .select("picked_normalized_question, correction_declined")
            .eq("message_id", messageId)
            .maybeSingle();
          if (correctionError) throw correctionError;
          selectedCorrection = selectedCorrection
            ?? (correctionJob?.picked_normalized_question as string | null ?? null);
          declined = declined || correctionJob?.correction_declined === true;
        }
        result = await answerQuestion(
          userId, question, makeDeps(messageId, picked, selectedCorrection, declined),
        );
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
          correction_options: result.correctionOptions ?? null,
          correction_question_message_id: result.correctionOptions ? messageId : null,
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
    // 모든 답변에 원 질문 id 를 실는다 — 품질 피드백(👍/👎)이 "어느 질문에 대한 평가인지"를
    // exact 로 결속하려면 필요하다. 답변 쪽지에서 dedup_key 접두를 파싱해 역산하면
    // 접두 규칙이 바뀌는 순간 조용히 깨진다.
    question_message_id: messageId,
    // 동명이인 되물기일 때만 선택지를 실는다. 클라는 이걸 보고 카드를 렌더한다.
    ...(result.pickerOptions
      ? {
        picker_options: result.pickerOptions.map((option) => ({
          kbo_id: option.kboId, name: option.name, team: option.team,
          position: option.position, back_no: option.backNo,
        })),
      }
      : {}),
    ...(result.correctionOptions ? { correction_options: result.correctionOptions } : {}),
    // 근거 문서 링크. 본문에는 `📄 출처: 나무위키` 표시명만 있고 클라가 여기에 앵커를 씌운다.
    // 내부 메타(revision·crawledAt·asOf)는 절대 payload 에 싣지 않는다 — 유저가 볼 이유가 없고
    // `crawled` 는 수집 사실을 화면에 적는 것이라 위험하다 (하린아빠 2026-08-05 P0).
    ...(result.sourceUrl ? { source_url: result.sourceUrl } : {}),
  };
  const deliveryDedupKey = result.source === "player_picker"
    ? `baseball-genius-picker:${messageId}`
    : result.source === "question_correction"
      ? `baseball-genius-correction:${messageId}`
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
      status: result.source === "player_picker" || result.source === "question_correction" ? "awaiting_selection" : "completed",
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
