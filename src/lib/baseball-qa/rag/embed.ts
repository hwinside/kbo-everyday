import { RAG_EMBEDDING_DIM } from "./contracts";

export const RAG_EMBEDDING_MODEL = "gemini-embedding-2";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${RAG_EMBEDDING_MODEL}:embedContent`;
const EMBED_TIMEOUT_MS = 10_000;

export type EmbeddingPurpose = "document" | "query";
export type EmbedResult =
  | { ok: true; vector: number[] }
  | { ok: false; reason: string };

/**
 * Gemini Embedding 2 공식 asymmetric retrieval 포맷.
 * 임의 접두사는 모델이 학습한 task prefix와 어긋나 index/query 정렬을 깨뜨린다.
 * query: `task: search result | query: {content}`
 * document: `title: {title} | text: {content}` (title 없으면 "none")
 */
export function formatQueryInput(text: string): string {
  return `task: search result | query: ${text}`;
}

export function formatDocumentInput(text: string, title?: string | null): string {
  const resolvedTitle = title?.trim() ? title.trim() : "none";
  return `title: ${resolvedTitle} | text: ${text}`;
}

export async function embedText(
  text: string,
  purpose: EmbeddingPurpose,
  fetchImpl: typeof fetch = fetch,
  title?: string | null,
): Promise<EmbedResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, reason: "missing_api_key" };
  if (!text.trim()) return { ok: false, reason: "empty_text" };

  const formatted = purpose === "query"
    ? formatQueryInput(text.trim())
    : formatDocumentInput(text.trim(), title);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${EMBED_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${RAG_EMBEDDING_MODEL}`,
        content: { parts: [{ text: formatted }] },
        outputDimensionality: RAG_EMBEDDING_DIM,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };

    const json: unknown = await response.json();
    const values = (json as { embedding?: { values?: unknown } }).embedding?.values;
    if (!Array.isArray(values)) return { ok: false, reason: "malformed_response" };
    if (values.length !== RAG_EMBEDDING_DIM) {
      return { ok: false, reason: `dim_mismatch_${values.length}` };
    }
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return { ok: false, reason: "non_finite_value" };
    }
    return { ok: true, vector: values as number[] };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export function embedDocument(
  text: string,
  pageTitle?: string | null,
  fetchImpl?: typeof fetch,
): Promise<EmbedResult> {
  return embedText(text, "document", fetchImpl, pageTitle);
}

export function embedQuery(text: string, fetchImpl?: typeof fetch): Promise<EmbedResult> {
  return embedText(text, "query", fetchImpl);
}
