/** Read-only PoC adapters. No production imports or schema changes. */
import { createHash } from "node:crypto";
import type { Evidence, SearchSource } from "../../../src/lib/baseball-qa/agent/poc";
type Row = Record<string, unknown>;
type ReadRows = (table: string, params: URLSearchParams, signal: AbortSignal) => Promise<Row[]>;
export function newsPageParams(now: string, offset: number): URLSearchParams {
  const params = new URLSearchParams({
    select: "article_key,title,content,link,published_at,embedding",
    embedding: "not.is.null", collected_at: `lte.${now}`, embedded_at: `lte.${now}`,
    order: "article_key.asc", limit: "250", offset: String(offset),
  });
  params.append("published_at", `gte.${new Date(Date.parse(now) - 30 * 86400000).toISOString()}`);
  params.append("published_at", `lte.${now}`);
  return params;
}
export function rankNews(rows: Row[], query: number[], now: string): Row[] {
  const norm = Math.hypot(...query);
  if (!norm) throw new Error("zero_query_vector");
  return rows.filter(row => Date.parse(String(row.published_at)) <= Date.parse(now)).map(row => {
    const vector: unknown = typeof row.embedding === "string" ? JSON.parse(row.embedding) : row.embedding;
    if (!Array.isArray(vector) || vector.length !== query.length || !vector.every(v => typeof v === "number" && Number.isFinite(v))) throw new Error("invalid_news_vector");
    const length = Math.hypot(...vector);
    if (!length) throw new Error("zero_news_vector");
    const score = vector.reduce((sum, v, i) => sum + v * query[i], 0) / (norm * length);
    return { row, score };
  }).sort((a, b) => b.score - a.score || String(a.row.article_key).localeCompare(String(b.row.article_key)))
    .slice(0, 6).map(item => item.row);
}
export function toEvidence(row: Row, source: SearchSource): Evidence {
  const content = String(row.content ?? "").slice(0, 6000);
  const fingerprint = createHash("sha256").update(JSON.stringify([row.source_key ?? row.article_key, row.revision, content])).digest("hex").slice(0, 24);
  return { id: `${source}:${fingerprint}`, source, title: String(row.title ?? row.page_title ?? ""), content,
    url: String(row.link ?? row.canonical_url ?? ""), asOf: String(row.published_at ?? row.as_of ?? "") };
}
const genericTerms = new Set(["야구", "선수", "경기", "일정", "결과", "명단", "팀", "국대"]);
export async function searchWiki(terms: string[], now: string, signal: AbortSignal, read: ReadRows): Promise<Evidence[]> {
  const documents = new Set<string>();
  const collected: Evidence[] = [];
  for (const term of [...new Set(terms)]) {
    const cleaned = term.replace(/[\s%*_,()\\]+/g, " ").trim();
    if (cleaned.length < 2 || genericTerms.has(cleaned)) continue;
    // Exclude already seen documents in the SERVER query, not after a chunk LIMIT.
    for (let page = 0; page < 3 && collected.length < 6; page++) {
      const params = new URLSearchParams({
        select: "source_key,page_title,content,canonical_url,revision,as_of",
        page_title: `ilike.*${cleaned}*`, source_kind: "eq.namu_document",
        as_of: `lte.${now.slice(0, 10)}`, limit: "2",
        order: "source_key.asc,chunk_index.asc",
      });
      for (const key of documents) {
        // PostgREST quoted scalar: escape quotes and backslashes, no raw filter expression.
        params.append("source_key", `neq."${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
      }
      const rows = await read("genius_rag_serving_chunks", params, signal);
      if (!rows.length) break;
      for (const row of rows) {
        const key = String(row.source_key ?? "");
        if (!key) throw new Error("missing_wiki_document_key");
        collected.push(toEvidence(row, "wiki"));
      }
      for (const row of rows) documents.add(String(row.source_key));
    }
  }
  return [...new Map(collected.map(e => [e.id, e])).values()].slice(0, 6);
}
