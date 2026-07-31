/**
 * 야잘알봇 v2 Hybrid RAG — 임베딩 스캐폴드 (rev0.7 §12).
 *
 * Gemini text-embedding-004(768차원)로 chunk를 벡터화한다. 차원은 migration의
 * vector(768) / RAG_EMBEDDING_DIM과 일치해야 하며, 응답 차원이 다르면 저장하지 않고
 * 실패로 반환한다(잘못된 차원이 조용히 섞이면 retrieval이 통째로 망가진다).
 *
 * 이 슬라이스에서는 대량 실행하지 않는다. 배치 실행 스케줄러는 GitHub Actions 또는
 * Vercel cron으로만 구동한다(P0, 맥미니 LaunchAgent/crontab 금지).
 */

import { RAG_EMBEDDING_DIM } from "./contracts";

export const RAG_EMBEDDING_MODEL = "text-embedding-004";

const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${RAG_EMBEDDING_MODEL}:embedContent`;

/** 외부 장애 전파를 막기 위한 bounded timeout. */
const EMBED_TIMEOUT_MS = 10_000;

export type EmbedResult =
  | { ok: true; vector: number[] }
  | { ok: false; reason: string };

/**
 * chunk 1건 임베딩. 실패는 예외가 아니라 결과값으로 반환한다(호출자가 재수집 큐로 넘김).
 * RETRIEVAL_DOCUMENT taskType = 문서 저장용(질의는 RETRIEVAL_QUERY로 별도).
 */
export async function embedChunk(text: string): Promise<EmbedResult> {
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
        taskType: "RETRIEVAL_DOCUMENT",
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
    return { ok: true, vector: values as number[] };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}
