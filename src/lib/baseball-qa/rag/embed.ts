import { RAG_EMBEDDING_DIM } from "./contracts";

export const RAG_EMBEDDING_MODEL = "gemini-embedding-2";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${RAG_EMBEDDING_MODEL}:embedContent`;
const EMBED_TIMEOUT_MS = 10_000;

export type EmbeddingPurpose = "document" | "query";
export type EmbedResult =
  | { ok: true; vector: number[] }
  | { ok: false; reason: string };

const INSTRUCTION_PREFIX: Record<EmbeddingPurpose, string> = {
  document: "문서 검색용 야구 지식: ",
  query: "질의 검색용 야구 질문: ",
};

export async function embedText(
  text: string,
  purpose: EmbeddingPurpose,
  fetchImpl: typeof fetch = fetch,
): Promise<EmbedResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, reason: "missing_api_key" };
  if (!text.trim()) return { ok: false, reason: "empty_text" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${EMBED_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${RAG_EMBEDDING_MODEL}`,
        content: { parts: [{ text: `${INSTRUCTION_PREFIX[purpose]}${text.trim()}` }] },
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

export function embedDocument(text: string, fetchImpl?: typeof fetch): Promise<EmbedResult> {
  return embedText(text, "document", fetchImpl);
}

export function embedQuery(text: string, fetchImpl?: typeof fetch): Promise<EmbedResult> {
  return embedText(text, "query", fetchImpl);
}
