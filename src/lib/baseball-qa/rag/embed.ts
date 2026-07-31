/**
 * 야잘알봇 v2 Hybrid RAG — 임베딩 스캐폴드 (rev0.7 §12).
 *
 * Gemini `gemini-embedding-2`로 chunk를 벡터화한다. 차원은 migration의 vector(768) /
 * RAG_EMBEDDING_DIM과 일치해야 하며, 응답 차원이 다르면 저장하지 않고 실패로 반환한다
 * (잘못된 차원이 조용히 섞이면 retrieval이 통째로 망가진다).
 *
 * 모델 계약 (2026-07-31 실측, 삼순 재리뷰 #2 반영):
 *   - `text-embedding-004`는 2026-01-14 shutdown → 현재 API에서 404. 사용 불가.
 *   - `gemini-embedding-2`는 기본 3072차원 → `outputDimensionality: 768`을 **반드시 명시**.
 *   - 이 모델은 `taskType` 필드를 지원하지 않는다(공식 문서 명시) → 대신 문서/질의를
 *     task instruction prefix로 포맷한다. 비대칭 retrieval 규격:
 *       문서: `title: {title} | text: {content}`  (title 없으면 `title: none`)
 *       질의: `task: question answering | query: {content}`
 *
 * 이 슬라이스에서는 대량 실행하지 않는다. 배치 실행 스케줄러는 GitHub Actions 또는
 * Vercel cron으로만 구동한다(P0, 맥미니 LaunchAgent/crontab 금지).
 */

import { RAG_EMBEDDING_DIM, RAG_EMBEDDING_MODEL } from "./contracts";

export { RAG_EMBEDDING_MODEL };

const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${RAG_EMBEDDING_MODEL}:embedContent`;

/** 외부 장애 전파를 막기 위한 bounded timeout. */
const EMBED_TIMEOUT_MS = 10_000;

/**
 * 문서 임베딩 입력 포맷(비대칭 retrieval의 document 측).
 * taskType 필드가 없는 모델이라 instruction을 본문에 실어 보낸다.
 */
export function formatDocumentInput(content: string, title?: string | null): string {
  const safeTitle = title && title.trim() !== "" ? title.trim() : "none";
  return `title: ${safeTitle} | text: ${content}`;
}

/**
 * 질의 임베딩 입력 포맷(비대칭 retrieval의 query 측).
 * 야잘알봇은 사용자의 야구 질문에 답하는 QA라 `question answering` task를 쓴다.
 */
export function formatQueryInput(query: string): string {
  return `task: question answering | query: ${query}`;
}

export type EmbedResult =
  | { ok: true; vector: number[] }
  | { ok: false; reason: string };

async function embedText(text: string): Promise<EmbedResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, reason: "missing_api_key" };
  if (!text.trim()) return { ok: false, reason: "empty_text" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${EMBED_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${RAG_EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        // 기본 3072 → vector(768) 계약에 맞춰 절단 차원을 명시(누락 시 차원 불일치).
        outputDimensionality: RAG_EMBEDDING_DIM,
      }),
      signal: controller.signal,
    });

    if (!res.ok) return { ok: false, reason: `http_${res.status}` };

    const json: unknown = await res.json();
    const values = (json as { embedding?: { values?: unknown } })?.embedding?.values;
    if (!Array.isArray(values)) return { ok: false, reason: "malformed_response" };
    if (values.length !== RAG_EMBEDDING_DIM) {
      return { ok: false, reason: `dim_mismatch_${values.length}` };
    }
    // NaN/Infinity가 섞이면 pgvector 저장이 실패하거나 유사도가 오염된다 → 저장 전 차단.
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) {
      return { ok: false, reason: "non_finite_values" };
    }
    return { ok: true, vector: values as number[] };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * chunk 1건 임베딩(문서 측). 실패는 예외가 아니라 결과값으로 반환한다(호출자가 재수집 큐로 넘김).
 */
export async function embedChunk(text: string, title?: string | null): Promise<EmbedResult> {
  if (!text.trim()) return { ok: false, reason: "empty_text" };
  return embedText(formatDocumentInput(text, title));
}

/** 질의 1건 임베딩(질의 측). 문서와 다른 prefix를 써야 비대칭 retrieval 품질이 나온다. */
export async function embedQuery(query: string): Promise<EmbedResult> {
  if (!query.trim()) return { ok: false, reason: "empty_text" };
  return embedText(formatQueryInput(query));
}
