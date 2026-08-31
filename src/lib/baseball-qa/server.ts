// 야잘알봇 질문 서버 처리 코어. POST /api/baseball-qa(즉시 경로)와
// /api/cron/baseball-qa-drain(durable 복구 경로)이 같은 처리기를 공유한다.
// 질문 INSERT와 같은 트랜잭션에서 trigger가 만든 genius_question_jobs 행을
// claim → (idempotent quota/LLM) 파이프라인 → ready 저장 → 답변 DM → completed 순으로 진행한다.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildQuestionLogRow } from "@/lib/baseball-qa/log-row";
import { planQuestionJobReady } from "@/lib/baseball-qa/job-ready-plan";
import { sendOpsMessageToUser } from "@/lib/cs/send-ops-message";
import {
  answerQuestion,
  BLOCKED_ANSWER,
  answerTeamIdForResult,
  answerPlayerRoleForTarget,
  geniusMotionForResult,
  GENIUS_MOTION_COOLDOWN_MS,
  isAckPhrase,
  MAX_QUESTION_LEN,
  SMALLTALK_STREAK_LIMIT,
  MIN_QUESTION_LEN,
  isPickedPlayerAllowed,
  type GlossaryEntry,
  type LlmResult,
  type QaDeps,
  type QaResult,
  type RagLlmExtras,
} from "@/lib/baseball-qa/pipeline";
import type { TodayGameStarters, NormalizeStatus } from "@/lib/baseball-qa/pipeline";
import { adaptTodayStarters } from "@/lib/baseball-qa/pipeline";
import { fetchGamesUserFacingWithMeta } from "@/lib/crawler/games-user-facing";
import {
  isFollowupPhrase,
  type ContextTurn,
  type PreviousTurnRow,
} from "@/lib/baseball-qa/context";
import {
  BASEBALL_GENIUS_USER_ID,
  composeGeniusReplyPayload,
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
  GLOSSARY_MAPPER_SYSTEM_PROMPT,
} from "@/lib/baseball-qa/gemini-request";
import { INTENT_CLASSIFIER_PROMPT } from "@/lib/baseball-qa/intent";
import {
  buildRagLlmRequest,
  RAG_SYSTEM_PROMPT,
  RAG_DOCUMENT_CANDIDATE_LIMIT,
  RAG_DOCUMENT_MAX_DISTANCE,
  RAG_NEWS_CANDIDATE_LIMIT,
  RAG_NEWS_SYSTEM_PROMPT,
  RAG_OFFICIAL_SYSTEM_PROMPT,
  RAG_TEAM_SYSTEM_PROMPT,
  searchSourcePriorityCandidates,
  resolveSeasonTarget,
  RAG_MAX_SEASON_LANES,
  type SeasonLaneMode,
  type SeasonTarget,
  type RagDocumentSourceKind,
  type RagEntityCandidate,
  type RagEvidence,
  type RagEvidenceCandidate,
  type RagNewsCandidate,
} from "@/lib/baseball-qa/rag/retrieve";
import type { RagSourceKind } from "@/lib/baseball-qa/rag/contracts";
import type { EvidenceProjector } from "@/lib/baseball-qa/rag/retrieve";
import { createSeasonRecordFetcher } from "@/lib/baseball-qa/stats/fetch-season-record";
import { createServedRecordFetcher } from "@/lib/baseball-qa/stats/served-record";
import { createCareerRecordFetcher } from "@/lib/baseball-qa/stats/career-series";
import { createCareerLeaderboardFetcher } from "@/lib/baseball-qa/stats/career-leaderboard";
import { createCareerMetricLeaderboardFetcher } from "@/lib/baseball-qa/stats/career-metric-leaderboard";
import careerMetricBaseline from "@/../data/baseball-qa/kbo-career-metrics-through-2025.json";
import { createEventRecordFetcher } from "@/lib/baseball-qa/stats/event-records";
import eventRecordSnapshot from "@/../data/baseball-qa/kbo-event-records-2026.json";
import { fetchServedCareerSnapshot } from "@/lib/baseball-qa/stats/served-record";
import { createSeriesPrizeHtmlFetcher } from "@/lib/baseball-qa/awards/series-prize";
import { createTeamRecordFetchers, kstSeasonOf } from "@/lib/baseball-qa/stats/team-record";
import type { SeasonRecordClient } from "@/lib/baseball-qa/stats/fetch-season-record";
import { renderTeamFanCopy } from "@/lib/constants/baseball-genius-team-copy";
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
  `질문 형식은 ${MIN_QUESTION_LEN}~${MAX_QUESTION_LEN}자의 텍스트입니다. 예: "보크가 뭐야?"`;

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

export async function callLlm(
  question: string,
  context?: ContextTurn,
  rosterBlock?: string,
  statIntentMode = false,
): Promise<LlmResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildBaseballQaGeminiRequest(question, SYSTEM_PROMPT, context, rosterBlock, statIntentMode)),
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
 * 의도 라우팅 분류기 — pipeline `classifyIntent` seam 구현 (2026-08-31).
 *
 * official RAG 검색보다 **먼저** 돌아 잡담·후속을 가른다. 이 호출이 생기는 이유는
 * `intent.ts` 헤더에 실측과 함께 있다 — 거리 임계는 한국어 짧은 구어를 걸러내지 못한다.
 *
 * ⚠️ `temperature: 0` 이다 — 같은 질문이 회차마다 다른 경로로 가면 유저는 불안정한
 *   봇을 겪고, 게이트도 판정을 고정할 수 없다(#1318 Q4 가 회차마다 갈린 것과 같은 축).
 * ⚠️ timeout 은 짧게 잡는다 — 이 단계는 **추가** 지연이므로 느리면 전체 응답이 느려진다.
 *   실패하면 호출부가 `BASEBALL` 로 fail-open 해 기존 경로 그대로 간다.
 */
export async function classifyIntent(
  question: string,
  context?: ContextTurn,
): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  // 직전 대화는 **데이터**로 구획해 넣는다 — 지시는 systemInstruction 에만 둔다
  // (`buildBaseballQaGeminiRequest` 의 로스터 블록과 같은 규약).
  const userText = context
    ? [
        "<직전 대화>",
        `질문: ${context.question}`,
        `답변: ${context.answer}`,
        "</직전 대화>",
        `이번 메시지: ${question}`,
      ].join("\n")
    : `이번 메시지: ${question}`;
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INTENT_CLASSIFIER_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Gemini API failed: ${res.status}`);
  const data = await res.json();
  return {
    text: data.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ?? "",
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
  const systemPrompt = GLOSSARY_MAPPER_SYSTEM_PROMPT;
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
  /**
   * 질문 임베딩과의 코사인 거리(작을수록 가깝다). RPC 가 임계로 이미 걸렀지만,
   * 호출자가 **관측**할 수 있어야 임계를 나중에 재보정할 수 있다(2026-08-27 실측 도입).
   */
  distance?: number;
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
    /**
     * 시즌 lane 집합. **DB 절단 전에** 목표 시즌 후보를 확보하기 위해 필요하다 —
     * 앱에서 재정렬하면 목표 청크가 상위 40 밖일 때 복구 불가다(삼순 2026-08-28 P0-①).
     * 생략하면 종전 단일 조회(전 시즌 대상 상위 N).
     *
     * 🔴 lane 팬아웃을 **구현체 안으로** 내린 이유(삼순 2026-08-29 6차 P0-3):
     *   호출자가 lane 마다 따로 부르면 `PGRST202` fallback 도 lane 마다 따로 돌아
     *   최악 2×lane×source 호출이 된다. 한 소스의 lane 을 한 번에 받으면 fallback 을
     *   소스당 1회로 합칠 수 있고, 호출 예산을 여기 한 곳에서 강제할 수 있다.
     */
    lanes?: Array<{ mode: SeasonLaneMode; year?: number }>,
  ) => Promise<RagEvidenceCandidate[]>;
}

/**
 * 한 소스당 허용하는 최대 RPC 호출 수 — lane 팬아웃 + `PGRST202` fallback 1회.
 *
 * 게이트가 이 상수로 호출 증폭을 판정한다(삼순 2026-08-29 6차 P0-3).
 * 바꾸려면 게이트와 같이 올려야 하므로 "조용한 증폭"이 구조적으로 불가능하다.
 */
export const RAG_MAX_RPC_PER_SOURCE = RAG_MAX_SEASON_LANES + 1;

/** 선수(tier2) 후보 정렬 RPC 이름 — 게이트가 이 상수로 production 배선을 결속한다. */
export const RAG_PLAYER_CHUNK_SEARCH_RPC = "search_baseball_genius_player_chunks" as const;

/**
 * PostgREST 가 "그 시그니처의 함수를 못 찾았다"고 말하는 코드.
 *
 * 🔴 왜 이걸 따로 다루는가 (삼순 2026-08-28 재리뷰 P0-③ "배포 순서도 fail-open"):
 *   migration 보다 앱이 먼저 뜼면 7인자 오버로드가 아직 없어 `PGRST202` 가 난다.
 *   그런데 이 경로는 throw 를 상위에서 잡아 **team RAG 를 조용히 양보한다** —
 *   즉 배포 순서 하나로 구단 서술 경로가 통째로 죽는다(유저는 이유를 모른다).
 *
 * 계약: **lane 은 최적화지 전제가 아니다.** 오버로드가 없으면 종전 5인자로 **한 번만**
 * 내려가 답한다(bounded — 재시도 루프 없음). recall 은 종전 수준으로 떨어지지만
 * 그것이 지금 리이브에 배포된 상태고, **아무 답도 안 하는 것보다 난다**.
 */
const PGRST_FUNCTION_NOT_FOUND = "PGRST202";

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
    fetchBySourceKind: async (candidate, sourceKind, limit, queryVector, lanes) => {
      // ⚠️ 여기서 **정렬 없이** `.from(...).limit(40)` 을 쓰면 안 된다 (2026-08-05 production 사고).
      //   문보경 나무위키 chunk 는 133건인데 무순서 40건만 받아오면 '문보물' 이 든 chunk_index 51 이
      //   후보에조차 못 들어와, 앱에서 코사인을 아무리 정확히 계산해도 복구할 수 없다.
      //   그래서 **DB(pgvector)가 질문 벡터 기준으로 정렬한 상위 N** 만 받는다.
      //   최종 근거 4건 선택과 소스 우선순위는 종전대로 앱이 하므로 embedding 도 함께 받는다.
      // 🔴 lane 은 **DB 인자**다 (삼순 2026-08-28 P0-①). 앱에서 거르면 이미 잘린 뒤라
      //   목표 시즌 청크가 상위 40 밖이면 영원히 복구되지 않는다. lane 없이 부르면
      //   종전 5인자 오버로드가 그대로 돌아 기존 경로(선수·뉴스)는 무영향이다.
      // ⚠️ 아래 주석은 호출문 **바로 앞**에 있어야 한다 — query-guard 는 직전 4줄만 읽는다.
      //   이번에 설명 주석을 사이에 끼워 넣었다가 CI 가 unbounded_rpc 로 잡았다.
      const baseArgs = {
        p_entity_type: candidate.entityType,
        p_entity_id: candidate.entityId,
        p_source_kind: sourceKind,
        p_query_embedding: JSON.stringify(queryVector),
        p_limit: limit,
      };
      // 🔴 호출 예산 (삼순 2026-08-29 6차 P0-3). lane 이 예산을 넘으면 **잘라서** 부른다 —
      //   lane 은 최적화라 못 도는 lane 이 있어도 any lane 이 답을 낸다. 예산을 액수로
      //   둘 수가 없으므로 여기서 구조적으로 강제한다(fallback 몴을 1회 남긴다).
      const planned = (lanes ?? []).slice(0, RAG_MAX_RPC_PER_SOURCE - 1);
      let rows: RagServingChunkRow[];
      if (planned.length === 0) {
        // query-guard: bounded -- RPC 가 1..50 으로 clamp 하는 정렬 조회이며 caller 는 RAG_CANDIDATE_LIMIT(40) 을 준다.
        const { data, error } = await client.rpc(RAG_PLAYER_CHUNK_SEARCH_RPC, baseArgs);
        if (error) throw error;
        rows = (data ?? []) as RagServingChunkRow[];
      } else {
        const results = await Promise.all(planned.map((lane) =>
          // query-guard: bounded -- RPC 가 1..50 으로 clamp 하는 정렬 조회이며 caller 는 RAG_CANDIDATE_LIMIT(40) 을 준다.
          client.rpc(RAG_PLAYER_CHUNK_SEARCH_RPC, {
            ...baseArgs,
            p_season_mode: lane.mode,
            p_season_year: lane.year ?? null,
          })));
        const failed = results.find((result) => result.error);
        // 🔴 migration-before-app 이 깨졌을 때의 bounded fallback (삼순 2026-08-28 P0-③).
        //   lane 오버로드가 아직 없으면 team RAG 가 통째로 사라진다 — 그건 배포 순서라는
        //   **우리 쪽 사정**을 유저 답변 손실로 전가하는 것이다. lane 없이 다시 부른다.
        //   ⚠️ 재시도는 **소스당 정확히 1회**다 — lane 마다 따로 재시도하면 오버로드가
        //   없는 순간 호출이 2배로 튀는다(삼순 6차 P0-3). lane 준 호출의 PGRST202 만
        //   fallback 하고, fallback 자체의 PGRST202 는 종전 함수조차 없다는 뜻이라 던진다.
        if (failed && (failed.error as { code?: string } | null)?.code === PGRST_FUNCTION_NOT_FOUND) {
          // query-guard: bounded -- 같은 RPC 의 종전 5인자 오버로드이며 p_limit 은 동일하게 bounded 다.
          const { data, error } = await client.rpc(RAG_PLAYER_CHUNK_SEARCH_RPC, baseArgs);
          if (error) throw error;
          rows = (data ?? []) as RagServingChunkRow[];
        } else {
          if (failed?.error) throw failed.error;
          rows = results.flatMap((result) => (result.data ?? []) as RagServingChunkRow[]);
        }
      }
      return rows.map((row) => ({
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

/**
 * team/player RAG 검색 **전체**에 걸리는 절대 deadline (삼순 2026-08-30 7차 P0-3, A안).
 *
 * 🔴 왜 개별 타임아웃으로 부족한가:
 *   embed 는 `AbortSignal` 로 10s 를 걸지만 RPC(`client.rpc`)에는 abort 신호가 없다.
 *   `Promise.all(planned.map(client.rpc))` 에서 **하나만 영원히 settle 되지 않으면**
 *   검색 전체가 무기한 정지하고, 유저는 응답 자체를 못 받는다. 병렬성 측정(P3f)은
 *   "응답이 오기만 하면" 통과하므로 never-settle 을 원리적으로 못 본다.
 *
 * 계약: 초과하면 **throw** 한다. 호출자(`pipeline.ts` team/player RAG)는 검색 실패를
 * catch 해 기존 generic 경로로 양보하므로, 유저는 늦은 답 대신 **다른 답**을 받는다.
 * 부분 근거로 답하지 않는다 — 근거 일부만으로 답하면 "왜 그 얘기가 빠졌나"가 된다(B안 기각).
 *
 * ⚠️ 이 값을 늘리려면 그만큼 유저가 빈 화면을 보는 시간이 늘어난다. 게이트가 상한을
 *   assertion 으로 박아둔다(P4a) — 조용히 키우면 RED 다.
 */
export const RAG_SEARCH_DEADLINE_MS = 8_000;

/** 게이트가 상한을 판정하는 기준. 이 위로 올리는 변경은 게이트를 통과하지 못한다. */
export const RAG_SEARCH_DEADLINE_MAX_MS = 15_000;

/**
 * 절대 deadline 래퍼. 초과 시 reject 하고, 정상 종료 시 타이머를 반드시 해제한다.
 *
 * ⚠️ `finally` 의 `clearTimeout` 이 없으면 요청이 끝나도 타이머가 이벤트 루프를 붙잡아
 *   서버리스 인스턴스가 늦게 정리된다. 성공·실패·타임아웃 세 경로 모두에서 해제된다.
 */
async function withAbsoluteDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_deadline_exceeded`)), deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function searchRag(
  candidate: RagEntityCandidate,
  question: string,
  /**
   * 상위 N 절단 **앞**에서 도는 근거 변환(선수 서술형 소개 전용).
   *
   * ⚠️ `slice(0, 6)` 뒤에 후처리로 걸면 앞 6건을 기록 chunk 가 먹어버린 뒤라 rank 7 이하의
   *   clean 소개 근거를 영원히 못 본다(삼순 2026-08-16 P1-a). 그래서 이 인자를 seam 안까지
   *   내려보낸다 — 호출자가 반환값을 가공하는 형태로는 순서 계약을 지킬 수 없다.
   */
  project?: EvidenceProjector,
  runtime: RagSearchRuntime = productionRagSearchRuntime,
  /**
   * 현재 시즌(KST 연도) 주입 seam. 게이트가 경계값을 넣을 수 있어야 하므로 인자다 —
   * 함수 안에서 `new Date()` 를 부르면 "작년에도 같은 판정이 나오는가"를 못 태운다.
   */
  now: () => number = Date.now,
  /**
   * 절대 deadline 주입 seam. 게이트가 짧은 값을 넣어 **초과 경로를 실제로 실행**할 수
   * 있어야 하므로 인자다 — 안에서 상수를 직접 읽으면 never-settle 축을 태울 수 없다.
   */
  deadlineMs: number = RAG_SEARCH_DEADLINE_MS,
): Promise<RagEvidence[]> {
  // 🔴 절대 deadline 은 embed 까지 **함께** 감싼다 (삼순 7차 P0-3, A안).
  //   never-settle 은 RPC 뿐 아니라 임베딩 fetch 에서도 난다 — embed 밖에 두면
  //   "타임아웃이 있다"는 말만 있고 실제로는 안 걸리는 구간이 남는다.
  return withAbsoluteDeadline(
    () => searchRagInner(candidate, question, project, runtime, now),
    deadlineMs,
    "rag_search",
  );
}

/** deadline 안에서 도는 실제 검색 본문. 계약은 `searchRag` 주석 참조. */
async function searchRagInner(
  candidate: RagEntityCandidate,
  question: string,
  project: EvidenceProjector | undefined,
  runtime: RagSearchRuntime,
  now: () => number,
): Promise<RagEvidence[]> {
  const embedded = await runtime.embed(question);
  if (!embedded.ok) return [];
  // query-guard: bounded -- entity + source_kind 폐쇄집합 각각 최대 40행. entity 전체를
  // 먼저 limit(40)하면 Namu 41건 뒤의 Wikipedia가 DB에서 소실된다.
  // 각 source_kind 안에서도 **질문 벡터 기준 상위 40건**이어야 한다(무순서 40건 금지).
  const currentSeason = kstSeasonOf(now());
  // 🔴 시즌 축은 **구단 경로에만** 켠다 (삼순 2026-08-28 P0-②).
  //   선수 문서는 `문보경/2025년` 처럼 시즌으로 쪼개져 있지 않고, 별명·프로필·학교 같은
  //   시점 무관 서술이 대부분이라 시즌 가중이 득보다 실이 크다. 구단 문서만 연도로
  //   쪼개져 있다는 것이 이 축의 전제이므로 전제가 성립하는 곳에만 적용한다.
  const seasonAware = candidate.entityType === "team";
  const seasonTarget: SeasonTarget = seasonAware
    ? resolveSeasonTarget(question, currentSeason)
    : { kind: "none" };

  return searchSourcePriorityCandidates(
    (sourceKind, limit, vector, lanes) =>
      runtime.fetchBySourceKind(candidate, sourceKind, limit, vector, lanes),
    embedded.vector,
    // 순서 강제가 아니라 **질문 의도별 가중**이다(삼순 P0).
    // 별명·여담은 나무위키를, 소속·프로필은 위키피디아를 살짝 올릴 뿐 반대편을 탈락시키지 않는다.
    tier2WeightForQuestion(question),
    project,
    // 🔴 시즌 인식 (2026-08-28). 나무위키 구단 문서는 `구단명/연도[/월]` 로 쪼개져 있어
    //   순수 코사인으로는 작년 문서가 올해를 이긴다 — `롯데 가을야구 갈 수 있을까?` 의
    //   top1 이 `롯데 자이언츠/2025년/9월`("진출 가능성 거의 사라진 상황")이었다.
    //   환각이 아니라 과거 문서를 정확히 읽은 것이므로, 고칠 지점은 생성이 아니라 검색이다.
    seasonAware ? currentSeason : undefined,
    seasonTarget,
  );
}

/** 근거를 비신뢰 데이터 블록으로만 전달하는 재서술 호출 (S2b). */
export async function callRagLlm(
  question: string,
  evidence: RagEvidence[],
  extras?: RagLlmExtras,
): Promise<LlmResult> {
  return callRagLlmWithPrompt(question, evidence, undefined, extras);
}

/** 공식 간행물(tier1) 근거 전용 호출 — 프롬프트만 다르고 경계는 동일하다. */
export async function callOfficialRagLlm(question: string, evidence: RagEvidence[]): Promise<LlmResult> {
  return callRagLlmWithPrompt(question, evidence, RAG_OFFICIAL_SYSTEM_PROMPT);
}

/**
 * 구단(tier2) 근거 전용 호출 — 프롬프트만 다르고 경계는 선수·공식 경로와 동일하다.
 *
 * 선수용 프롬프트를 재사용하지 않는다 — "선수 소개 도우미"로 자기규정한 모델은
 * 구단 질문을 범위 밖으로 오판하고, 숫자 전면금지라 연도가 들어간 구단 서사를 전부 거부한다.
 */
export async function callTeamRagLlm(
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

/**
 * production 요청 본문 조립 — `callRagLlmWithPrompt` 가 Gemini 에 실제로 보내는 바로 그 payload.
 *
 * 🔴 왜 별도 export 함수인가 (삼순 2026-08-28 4차 NO-GO ① — 실재했던 결함):
 *   종전에는 fetch 안에서 `{ context, rosterBlock }` 만 손으로 재조립했다. 그래서
 *   pipeline 이 `liveTeamBlock`·`evidenceTime` 을 넘겨도 **여기서 조용히 버려졌고**,
 *   이 PR 은 프로덕션에서 아무 일도 하지 않고 있었다. 게이트는 mock extras 캐처와
 *   builder 직접 호출을 **따로** 태워서 GREEN 이었다(전형적인 false-green).
 *
 *   근본 원인은 "extras 를 손으로 옮기는 지점"이 존재한다는 것이다 — 필드를 추가할 때마다
 *   여기를 같이 고쳐야 하고, 안 고쳐도 타입이 통과한다. 그래서 **재조립을 없앨다** —
 *   extras 를 그대로 넘기면 필드 추가 시 자동으로 하류까지 간다(구조적으로 누락 불가).
 *   그리고 게이트가 **배포되는 바로 이 함수**를 태워 payload 를 검사할 수 있게 export 한다.
 */
export function buildProductionRagRequest(
  question: string,
  evidence: RagEvidence[],
  systemPrompt?: string,
  extras?: RagLlmExtras,
): ReturnType<typeof buildRagLlmRequest> {
  // ⚠️ 여기서 필드를 골라 적지 않는다. `extras` 를 통째로 넘긴다 — 그게 계약이다.
  return buildRagLlmRequest(question, evidence, systemPrompt ?? RAG_SYSTEM_PROMPT, extras ?? {});
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
      buildProductionRagRequest(question, evidence, systemPrompt, extras),
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
export async function searchOfficialRag(question: string): Promise<RagEvidence[]> {
  const embedded = await embedQuery(question);
  if (!embedded.ok) return [];
  // query-guard: bounded -- RPC가 RAG_DOCUMENT_CANDIDATE_LIMIT 상한을 강제하는 정렬 조회다.
  const { data, error } = await supabaseAdmin.rpc("search_baseball_genius_official_chunks", {
    p_query_embedding: JSON.stringify(embedded.vector),
    p_limit: RAG_DOCUMENT_CANDIDATE_LIMIT,
    // 🔴 **유사도 임계**를 넘겨준다 (2026-08-27 실측 도입).
    //   임계가 없으면 RPC 는 무슨 질문이든 상한만큼 돌려준다 — "오늘 점심 뭐 먹지?" 도
    //   12건을 받았다. 개수로는 근거 유무를 판정할 수 없고, RAG-first 라우팅은
    //   그 판정 위에 서 있으므로 임계가 없으면 전 질문이 환각 통로가 된다.
    //   값은 앱 상수 SSOT 이며, RPC 가 0.60 상한을 다시 강제한다(무력화 방지).
    p_max_distance: RAG_DOCUMENT_MAX_DISTANCE,
  });
  // 🔴 **배포 순서 방어** (2026-08-27 프로덕션 실측으로 확인한 실제 위험).
  //   이 PR 은 RPC 시그니처를 바꾼다(`p_max_distance` 추가). 앱이 migration 보다 **먼저**
  //   배포되면 PostgREST 가 함수를 못 찾아 `PGRST202` 404 를 낸다 — 실측:
  //     구 시그니처 → HTTP 200 / 신 시그니처 → HTTP 404 PGRST202
  //   여기서 throw 하면 공식 RAG 경로가 통째로 예외가 되어 유저에게 오류가 나간다.
  //
  //   ⚠️ 구 시그니처로 **재시도하지 않는다.** 구 RPC 는 임계가 없어 무슨 질문이든 상한만큼
  //     돌려주므로, 재시도는 "근거 없음을 근거 있음으로 만드는" 바로 그 결함으로 되돌아간다.
  //     대신 **근거 0건으로 접는다** — 라우팅은 종전 경로로 그대로 흘러 오늘과 같은 동작이
  //     되고(기능 손실 없음), migration 이 적용되는 순간 자동으로 새 동작이 켜진다.
  if (error) {
    if (error.code === "PGRST202") return [];
    throw error;
  }
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
    // 🔴 거리를 호출자까지 실어 올린다 (삼순 2026-08-27 "distance 가 RagEvidence/로그로 전달되지
    //   않아 72시간 재보정 근거가 약하다"). 임계를 값으로 두면서 그 값이 실제로 어떤
    //   분포를 자르고 있는지를 관측 안 하면, 재보정은 영원히 "감"으로 한다.
    //   ⚠️ **부재와 0 을 섞지 않는다** — RPC 가 값을 안 주면 undefined 로 둔다.
    //     소유권 판정이 이 값을 쓰는데, 미제공을 0 으로 응급처리하면 "가장 가까움"으로
    //     읽혀 migration 이전 배포에서 소유권이 통째로 뒤집힌다.
    distance: typeof row.distance === "number" ? row.distance : undefined,
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
export async function searchNewsRag(
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
export async function callNewsRagLlm(question: string, evidence: RagEvidence[]): Promise<LlmResult> {
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
  signatureUserId?: string,
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
    /** KBO 공식 2026 레코드북 p.104의 정규시즌 노히트노런 사건 원장. */
    fetchEventRecord: createEventRecordFetcher(() => eventRecordSnapshot),
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
    // 의도 라우팅 분류기 — official RAG 앞에서 잡담·후속을 가른다(2026-08-31).
    classifyIntent,
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
    // 팀별 팬 카피 (rev2) — 단독 인사에서만 pipeline 이 호출한다.
    //   · 팀 = `profiles.team_id` (유저 본인 행 1건 조회). 미설정·미지원 값은 null → 기존 인사.
    //   · 로테이션 시드 = **messageId** — job 행에 고정된 값이라 cron drain 재처리도
    //     같은 카피를 재생한다 (process-local 카운터·Math.random 금지, M90 계약).
    //   · 조회 실패는 throw → pipeline 이 삼켜 fail-open (인사 응답을 죽이지 않는다).
    pickTeamFanCopy: signatureUserId ? async () => {
      // query-guard: bounded -- id PK 단일 행의 team_id 한 칸만 읽는다.
      const { data, error } = await supabaseAdmin
        .from("profiles")
        .select("team_id")
        .eq("id", signatureUserId)
        .maybeSingle();
      if (error) throw error;
      const teamId = data?.team_id == null ? null : Number(data.team_id);
      return renderTeamFanCopy(teamId, messageId);
    } : undefined,
    // §7.4 연속 smalltalk 남용 신호 — 현재 질문 **이전** 로그의 연속 ack 수.
    //   기준 시각 = 질문 dm_messages.created_at (job 행에 고정 — durable 재처리 동일 판정).
    //   현재 런의 로그 행은 질문 시각 **이후**에 쓰이므로 lt 필터가 자연 배제한다.
    loadSmalltalkStreak: signatureUserId ? async () => {
      // query-guard: bounded -- 질문 행 1건 + 직전 로그 3건(ORDER 명시 — 무정렬 LIMIT 금지 M90).
      const { data: questionRow, error: questionError } = await supabaseAdmin
        .from("dm_messages")
        .select("created_at")
        .eq("id", messageId)
        .maybeSingle();
      if (questionError) throw questionError;
      const questionAt = (questionRow?.created_at as string | undefined) ?? null;
      if (!questionAt) return 0;
      // query-guard: bounded -- user_id 스코프 + created_at < 질문시각 keyset 커서에
      // ORDER BY created_at DESC + LIMIT SMALLTALK_STREAK_LIMIT(3). 테이블이 커져도
      // 읽는 행 수는 상수 3으로 고정된다(연속 판정에 4번째 행은 필요 없다).
      const { data, error } = await supabaseAdmin
        .from("genius_question_logs")
        .select("match_path, created_at")
        .eq("user_id", signatureUserId)
        .lt("created_at", questionAt)
        .order("created_at", { ascending: false })
        .limit(SMALLTALK_STREAK_LIMIT);
      if (error) throw error;
      let streak = 0;
      for (const row of data ?? []) {
        if ((row as { match_path: string }).match_path === "ack") streak += 1;
        else break;
      }
      return streak;
    } : undefined,
    claimPositiveEnding: signatureUserId ? async (baseAnswer) => {
      // query-guard: bounded -- message_id idempotency + user별 최근 5행을 한 DB 트랜잭션에서 판정·기록한다.
      const { data, error } = await supabaseAdmin
        .rpc("claim_baseball_genius_positive_ending", {
          p_message_id: messageId,
          p_user_id: signatureUserId,
          p_base_answer: baseAnswer,
        })
        .single();
      if (error || !data) throw error ?? new Error("positive ending claim missing");
      return (data as { answer: string }).answer;
    } : undefined,
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
    // ── 의도 판정 durable 재생 (삼순 2026-08-31 ①) ────────────────────────────
    //   키가 `message_id` 라 **이 메시지 전용**이다 — 전역 캐시가 아니다.
    //   fingerprint 대조는 파이프라인(`replayableIntent`)이 하므로 여기선 행만 읽는다.
    //
    //   ⚠️ 컬럼 부재(migration 미적용)를 **기능 장애로 만들지 않는다.** 앱이 migration 보다
    //     먼저 배포되는 창에서 42703/PGRST204 가 나는데, 그때 throw 하면 라우팅이 통째로
    //     죽는다. "판정 없음"(null)으로 접으면 매번 새로 분류할 뿐 동작은 유지된다
    //     (#1317 의 PGRST202 fail-soft 와 같은 축).
    // ── 최초 정규화 판정 snapshot (삼순 2026-08-31 NO-GO ②) ────────────────
    //   판정 재생의 시작점을 정규화까지 끌어올린다 — 정규화가 흔들리면 fingerprint 가
    //   달라져 판정 재생이 아예 발동하지 않기 때문이다.
    getNormalizeSnapshot: async () => {
      const { data, error } = await supabaseAdmin
        .from("genius_question_jobs")
        .select("normalize_snapshot_question, normalize_snapshot_status, normalize_snapshot_accepted, normalize_snapshot_suggestion")
        .eq("message_id", messageId)
        .maybeSingle();
      if (error) {
        // 컬럼 미배포 창에서는 "snapshot 없음" 으로 접는다(라우팅을 죽이지 않는다).
        if (error.code === "42703" || error.code === "PGRST204") return null;
        throw error;
      }
      const q = (data?.normalize_snapshot_question as string | null) ?? null;
      const st = (data?.normalize_snapshot_status as string | null) ?? null;
      if (!q || !st) return null;
      return {
        originalQuestion: q,
        status: st as NormalizeStatus,
        acceptedText: (data?.normalize_snapshot_accepted as string | null) ?? null,
        suggestionText: (data?.normalize_snapshot_suggestion as string | null) ?? null,
      };
    },
    storeNormalizeSnapshot: async (snapshot) => {
      // 최초 1회만 쓴다. 이미 있으면 내가 CAS 패자이므로 winner 를 읽어 돌려준다
      // (판정 저장과 같은 계약 — 두 worker 가 서로 다른 문장으로 답하면 재생이 깨진다).
      const { data, error } = await supabaseAdmin
        .from("genius_question_jobs")
        .update({
          normalize_snapshot_question: snapshot.originalQuestion,
          normalize_snapshot_status: snapshot.status,
          normalize_snapshot_accepted: snapshot.acceptedText,
          normalize_snapshot_suggestion: snapshot.suggestionText,
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", messageId)
        .is("normalize_snapshot_status", null)
        .select("normalize_snapshot_status");
      if (error) {
        if (error.code === "42703" || error.code === "PGRST204") return null;
        throw error;
      }
      if ((data?.length ?? 0) > 0) return null; // winner — 내 판정을 쓴다

      const { data: won, error: readErr } = await supabaseAdmin
        .from("genius_question_jobs")
        .select("normalize_snapshot_question, normalize_snapshot_status, normalize_snapshot_accepted, normalize_snapshot_suggestion")
        .eq("message_id", messageId)
        .maybeSingle();
      if (readErr || !won?.normalize_snapshot_status) return null; // 읽기 실패는 내 판정 유지
      return {
        originalQuestion: (won.normalize_snapshot_question as string | null) ?? snapshot.originalQuestion,
        status: won.normalize_snapshot_status as NormalizeStatus,
        acceptedText: (won.normalize_snapshot_accepted as string | null) ?? null,
        suggestionText: (won.normalize_snapshot_suggestion as string | null) ?? null,
      };
    },
    getIntentDecision: async () => {
      const { data, error } = await supabaseAdmin
        .from("genius_question_jobs")
        .select("intent_verdict, intent_fingerprint, intent_answer, intent_clarify, intent_team, intent_verdict_known")
        .eq("message_id", messageId)
        .maybeSingle();
      if (error) {
        if (error.code === "42703" || error.code === "PGRST204") return null;
        throw error;
      }
      if (!data) return null;
      return {
        verdict: (data.intent_verdict as string | null) ?? null,
        fingerprint: (data.intent_fingerprint as string | null) ?? null,
        answer: (data.intent_answer as string | null) ?? null,
        clarify: (data.intent_clarify as string | null) ?? null,
        team: (data.intent_team as string | null) ?? null,
        // 구 행은 컬럼이 NULL 이다 — `replayableIntent` 가 false 로 접는다(모름 → 개방 철회).
        verdictKnown: (data.intent_verdict_known as boolean | null) ?? null,
      };
    },
    storeIntentDecision: async ({ verdict, fingerprint, answer, clarify, team, verdictKnown }) => {
      // ── 원자적 CAS (삼순 2026-08-31 P0-2) ──────────────────────────────────
      //
      // 🔴 초안은 `.is("intent_verdict", null)` 이었는데 그게 **결함**이었다.
      //   fingerprint 가 바뀌면(프롬프트 수정·맥락 변경) `replayableIntent` 는 재생을
      //   거부하고 재분류하는데, 저장은 "verdict 가 null 일 때만" 이라 **옛 판정이 영원히
      //   남는다.** 그러면 그 messageId 는 재시도마다 새로 분류되고 매번 흔들린다 —
      //   재현성을 위해 만든 층이 정확히 재현성을 잃는 자리였다.
      //
      // 그래서 조건을 "**이 fingerprint 의 최초 판정**" 으로 바꾼다:
      //   verdict 가 없거나(최초) · 저장된 fingerprint 가 지금 것과 다르면(계약이 바뀜) 쓴다.
      //   이미 같은 fingerprint 의 판정이 있으면 0행 → 내가 CAS 패자다.
      //
      // ⚠️ 패자는 **DB winner 를 읽어 그 판정을 쓴다.** 자기 판정을 쓰면 두 worker 가 서로
      //   다른 답을 내보내 재생 계약이 깨진다(경합은 드물지만 durable 재처리에서 실재한다).
      const { data, error } = await supabaseAdmin
        .from("genius_question_jobs")
        .update({
          intent_verdict: verdict,
          intent_fingerprint: fingerprint,
          intent_answer: answer,
          intent_clarify: clarify,
          intent_team: team,
          // 🔴 provenance 는 판정과 **같은 update** 에 실린다 (삼순 NO-GO ①).
          //   따로 쓰면 "판정은 저장됐는데 provenance 만 없는" 행이 생겨, 재생 때
          //   모름을 판정으로 오인한다(값과 provenance 를 같은 조건에 결속한다, M90).
          intent_verdict_known: verdictKnown,
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", messageId)
        .or(`intent_verdict.is.null,intent_fingerprint.neq.${fingerprint}`)
        .select("intent_verdict");
      if (error) {
        if (error.code === "42703" || error.code === "PGRST204") return null;
        throw error;
      }
      if ((data?.length ?? 0) > 0) return null; // 내가 winner — 내 판정을 쓴다

      // CAS 패자 — 이미 저장된 winner 판정을 읽어 돌려준다.
      const { data: won, error: readErr } = await supabaseAdmin
        .from("genius_question_jobs")
        .select("intent_verdict, intent_fingerprint, intent_answer, intent_clarify, intent_team, intent_verdict_known")
        .eq("message_id", messageId)
        .maybeSingle();
      if (readErr || !won) return null; // 읽기 실패는 내 판정 유지(fail-open)
      return {
        verdict: (won.intent_verdict as string | null) ?? null,
        fingerprint: (won.intent_fingerprint as string | null) ?? null,
        answer: (won.intent_answer as string | null) ?? null,
        clarify: (won.intent_clarify as string | null) ?? null,
        team: (won.intent_team as string | null) ?? null,
        verdictKnown: (won.intent_verdict_known as boolean | null) ?? null,
      };
    },
    // 되묻기 렌더 결과 고정 (삼순 2026-08-31 P0-3).
    //   조건이 `intent_answer.is.null` 인 이유: 판정 저장(`storeIntentDecision`)이 이미
    //   이 fingerprint 를 확정해 놨고, 렌더는 그 뒤에 **한 번만** 붙는다. 이미 문구가
    //   있으면 내가 CAS 패자이므로 그 문구를 읽어 돌려준다.
    storeIntentRender: async (fingerprint, rendered) => {
      const { data, error } = await supabaseAdmin
        .from("genius_question_jobs")
        .update({ intent_answer: rendered, updated_at: new Date().toISOString() })
        .eq("message_id", messageId)
        .eq("intent_fingerprint", fingerprint)
        .is("intent_answer", null)
        .select("intent_answer");
      if (error) {
        if (error.code === "42703" || error.code === "PGRST204") return null;
        throw error;
      }
      if ((data?.length ?? 0) > 0) return null; // winner — 내 렌더를 쓴다

      const { data: won, error: readErr } = await supabaseAdmin
        .from("genius_question_jobs")
        .select("intent_answer")
        .eq("message_id", messageId)
        .eq("intent_fingerprint", fingerprint)
        .maybeSingle();
      if (readErr || !won) return null; // 읽기 실패는 내 렌더 유지(fail-open)
      return (won.intent_answer as string | null) ?? null;
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
          userId, question, makeDeps(messageId, picked, selectedCorrection, declined, userId),
        );
      }
      if (result.source === "pending") {
        // LLM winner가 다른 worker (CAS 패배/fence 창) — 이 worker는 ready 저장도 발송도 하지
        // 않고 물러난다. job은 winner가 끝까지 소유하며, winner crash 시에만 다음 drain이
        // fence 경과 후 ambiguous fail-closed 복구로 이어받는다 (삼순 5차 P1).
        return { kind: "pending" };
      }
      // ready 전환 경로는 `planQuestionJobReady` SSOT 가 정한다 — 교정 제안은 quota 반납과
      // 후보 durable 저장을 **한 트랜잭션**으로 닫는다(삼순 2026-08-13 quota/crash).
      // 둘을 나누면 그 사이 crash 가 무료 질문 또는 이중 과금을 만든다.
      const plan = planQuestionJobReady(result, messageId);
      if (plan.kind === "settle_correction") {
        // query-guard: bounded -- message_id 단위 단일 행 갱신 RPC.
        const { data: settled, error: settleError } = await supabaseAdmin
          .rpc("settle_baseball_genius_correction_suggestion", {
            p_message_id: messageId,
            p_user_id: userId,
            p_answer: plan.answer,
            p_correction_option: plan.correctionOption,
          });
        if (settleError) throw settleError;
        // false = 이 worker 가 소유한 processing 행이 아니다(다른 worker 가 이미 진행).
        if (settled !== true) return { kind: "pending" };
      } else {
        const { error: readyError } = await supabaseAdmin
          .from("genius_question_jobs")
          .update({ ...plan.row, updated_at: new Date().toISOString() })
          .eq("message_id", messageId)
          .eq("status", "processing");
        if (readyError) throw readyError;
      }
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

  // 답변 유형·모션을 payload 에 함께 저장한다 — 클라가 유형별 마스코트·모션을 고를 근거(SSOT).
  // 조립은 composeGeniusReplyPayload 단일 함수가 한다 — 인라인이면 게이트가 실제 조립
  // 경로를 못 태운다(#1102 SSOT 추출과 같은 축). 필드 계약·금지 메타 규칙은 그 함수 문서에.
  // 모션은 **여기 단일 지점**에서 (source, question) 결정론 계산 — 즉시 경로·durable 재시도
  // (claimState="ready")·길이 위반 blocked·pipeline 조기 blocked 전부 같은 계산을 탄다
  // (삼순 #1197 NO-GO ②③: result 에 실어 나르면 ready 재시도에서 소실되고 조기 반환에서 누락된다).
  // §7.4 모션 30초 1회 — **원자 claim** (삼순 #1202 P0).
  //   종전엔 `SELECT 직전 모션` 과 답변 INSERT 가 별도 트랜잭션이라, 같은 유저의 두 메시지가
  //   동시에 들어오면 둘 다 같은 lastMotionAt 을 읽고 둘 다 모션을 붙였다(30초 1회 파괴).
  //   이제 유저 advisory lock + message_id 멱등 + 쿨다운 판정 + 부여 기록을 RPC 한 트랜잭션에
  //   묶는다(positive ending 시그니처와 같은 축).
  //
  //   · 후보 모션은 결정론 계산(geniusMotionForResult) — 어떤 모션인지는 코드가 정한다.
  //   · 실제 부여 여부는 DB 가 정한다 — 동시성·멱등은 DB 만 보장할 수 있다.
  //   · 기준 시각은 질문 dm_messages.created_at (job 행 고정값) — wall clock 이면 durable
  //     재시도 시점에 따라 모션이 생겼다 사라진다(#1197 ②③ 계약).
  //   · payload 시각을 함께 넘긴다 — 원장 도입 **이전**에 나간 모션도 쿨다운을 밀어야 한다.
  //   · RPC 실패는 후보 모션 그대로 유지(fail-open) — 관측·원장 장애가 감정 반응을 죽이면 안 된다.
  const candidateMotion = geniusMotionForResult(result.source, question);
  let motion = candidateMotion;
  try {
    // query-guard: bounded -- 질문 행 1건 + 직전 모션 payload 1건(ORDER 명시) + 단일 RPC.
    const { data: questionRow } = await supabaseAdmin
      .from("dm_messages")
      .select("created_at")
      .eq("id", messageId)
      .maybeSingle();
    const decidedAt = (questionRow?.created_at as string | undefined) ?? null;
    if (decidedAt) {
      const { data: lastMotionRow } = await supabaseAdmin
        .from("dm_messages")
        .select("created_at")
        .eq("conversation_id", conversationId)
        .eq("sender_id", BASEBALL_GENIUS_USER_ID)
        .not("payload->>motion", "is", null)
        .lt("created_at", decidedAt)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data: claim, error: claimMotionError } = await supabaseAdmin
        .rpc("claim_baseball_genius_motion", {
          p_message_id: messageId,
          p_user_id: userId,
          p_motion: candidateMotion ?? null,
          p_decided_at: decidedAt,
          p_cooldown_ms: GENIUS_MOTION_COOLDOWN_MS,
          p_payload_last_motion_at: (lastMotionRow?.created_at as string | undefined) ?? null,
        })
        .single();
      if (claimMotionError) throw claimMotionError;
      const granted = (claim as { motion: string | null } | null)?.motion ?? null;
      motion = granted === null ? undefined : (granted as typeof candidateMotion);
    }
  } catch (error) {
    console.error("baseball-genius motion claim failed:", (error as Error).message);
  }
  // 응원 7종 자격 — 답변 대상 구단 id 를 payload 에 싣는다(하린아빠 2026-08-16 14:09).
  // 모션과 **같은 단일 지점**에서 (source, question) 결정론 계산 — durable 재시도·조기
  // blocked 반환도 같은 값을 얻는다(#1197 계약과 동일 축). 최애팀과의 비교는 클라가 한다:
  // 서버는 "이 답변이 어느 팀 얘기인가"만 알고, "누가 보고 있는가"는 모른다.
  const answerTeamId = answerTeamIdForResult(result.source, question);
  // 답변 대상 선수의 역할(투수/타자) — 답변 모션을 포지션에 맞춤다(하린아빠 2026-08-19).
  // ⚠️ raw question 이 아니라 **실제 답변 대상**에 결속한다(삼순 #1251 P1):
  //   persisted picked_player_kbo_id → picked_normalized_question → raw question.
  //   picker 에서 한 명을 골랐는데 raw question 으로 재계산하면 동명이인 역할 혼재로
  //   null→시드 교대가 되어 같은 오모션이 재발한다. job 행이 SSOT 라 즉시 경로·교정 승인·
  //   ready 재시도(cron drain) 어느 경로로 와도 같은 대상으로 같은 역할이 나온다(#1197 축).
  //   조회 실패는 질문 기반 fallback 이 아니라 **역할 없음**으로 fail-close 한다 —
  //   picked 가 있었을지 모르는 상태에서 질문 기반으로 내려가면 오결속이 된다.
  // query-guard: bounded -- message_id PK 단일 행 조회.
  let answerPlayerRole: ReturnType<typeof answerPlayerRoleForTarget> = null;
  try {
    const { data: targetJob, error: targetJobError } = await supabaseAdmin
      .from("genius_question_jobs")
      .select("picked_player_kbo_id, picked_normalized_question")
      .eq("message_id", messageId)
      .maybeSingle();
    if (targetJobError) throw targetJobError;
    answerPlayerRole = answerPlayerRoleForTarget(
      result.source,
      {
        // 입력값이 있으면 우선(이번 요청이 방금 고정한 값), 없으면 job 행(durable 재시도).
        pickedPlayerKboId: input.pickedPlayerKboId
          ?? (targetJob?.picked_player_kbo_id as string | null ?? null),
        correctedQuestion: targetJob?.picked_normalized_question as string | null ?? null,
        question,
      },
      await loadRosterPlayers(),
    );
  } catch (error) {
    console.error("baseball-genius answer player role lookup failed:", (error as Error).message);
  }
  // ⚠️ `motion`(부여)과 `motionIntent`(의미)를 **둘 다** 싣는다.
  //    쿨다운이 거절하면 motion 은 비지만, 그렇다고 "감사"가 "인사"가 되는 건 아니다.
  //    intent 를 함께 실어야 클라가 의미를 잃지 않는다(삼순 2026-08-16 P0).
  const replyPayload: GeniusReplyPayload = composeGeniusReplyPayload(
    { ...result, motion, motionIntent: candidateMotion, answerTeamId, answerPlayerRole },
    messageId,
  );
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
