/** CLI only. Input is an anonymized ConversationInput JSON file; stdout is local evidence, never a DM. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runAgentPoc, type Evidence, type SearchRequest } from "../../../src/lib/baseball-qa/agent/poc";
import { BASEBALL_QA_GEMINI_MODEL } from "../../../src/lib/baseball-qa/gemini-request";
import { formatQueryInput, RAG_EMBEDDING_MODEL } from "../../../src/lib/baseball-qa/rag/embed";

const file = process.argv[2];
if (!file || !process.argv.includes("--read-only")) {
  throw new Error("usage: tsx scripts/baseball-qa/agent/run-poc.ts input.json --read-only");
}
const apiKey = process.env.GEMINI_API_KEY;
const databaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const databaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!apiKey || !databaseUrl || !databaseKey) throw new Error("Required protected environment is unavailable");
const base = new URL(databaseUrl);
if (base.protocol !== "https:") throw new Error("HTTPS database URL required");
const model = process.env.YAJ_POC_MODEL || BASEBALL_QA_GEMINI_MODEL;
if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error("invalid model identifier");
let input: unknown;
try { input = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("invalid input file"); }

async function readRows(table: string, params: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>[]> {
  const url = new URL(`/rest/v1/${table}`, base);
  url.search = params.toString();
  const response = await fetch(url, { method: "GET", signal,
    headers: { apikey: databaseKey!, Authorization: `Bearer ${databaseKey}` } });
  if (!response.ok) throw new Error(`read_failed_${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("invalid_database_response");
  return data as Record<string, unknown>[];
}

async function search(request: SearchRequest, now: string, signal: AbortSignal): Promise<Evidence[]> {
  if (request.source !== "wiki") {
    const embedded = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${RAG_EMBEDDING_MODEL}:embedContent`, {
      method: "POST", signal, headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey! },
      body: JSON.stringify({ model: `models/${RAG_EMBEDDING_MODEL}`, content: { parts: [{ text: formatQueryInput(request.query) }] }, outputDimensionality: 768 }),
    });
    if (!embedded.ok) throw new Error("embedding_failed");
    const vector = (await embedded.json()).embedding?.values;
    if (!Array.isArray(vector) || vector.length !== 768 || !vector.every(v => typeof v === "number" && Number.isFinite(v))) throw new Error("invalid_embedding");
    const news = request.source === "news";
    const rpc = news ? "search_baseball_genius_news_articles" : "search_baseball_genius_official_chunks";
    const args = news
      ? { p_query_embedding: JSON.stringify(vector), p_team_ids: [1,2,3,4,5,6,7,8,9,10], p_limit: 12,
        p_published_after: new Date(Date.parse(now) - 30 * 86_400_000).toISOString() }
      : { p_query_embedding: JSON.stringify(vector), p_limit: 6, p_max_distance: 0.42 };
    const response = await fetch(new URL(`/rest/v1/rpc/${rpc}`, base), { method: "POST", signal,
      headers: { "Content-Type": "application/json", apikey: databaseKey!, Authorization: `Bearer ${databaseKey}` }, body: JSON.stringify(args) });
    if (!response.ok) throw new Error("search_rpc_failed");
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error("invalid_rpc_response");
    return rows.filter(row => Date.parse(row.published_at ?? row.as_of) <= Date.parse(now)).slice(0, 6).map(row => ({
      id: `${request.source}:${createHash("sha256").update(JSON.stringify([row.article_key, row.canonical_url, row.revision, row.content])).digest("hex").slice(0, 24)}`,
      source: request.source, title: String(row.title ?? row.page_title ?? ""), content: String(row.content ?? "").slice(0, 6000),
      url: String(row.link ?? row.canonical_url ?? ""), asOf: String(row.published_at ?? row.as_of ?? ""),
    }));
  }
  // Bounded lexical PoC search, not claimed to be full-corpus semantic retrieval.
  // Each term is passed as a URLSearchParams value, never a PostgREST `or` expression.
  const collected: Evidence[] = [];
  for (const term of request.terms) {
    const cleaned = term.replace(/[\s%*_,()\\]+/g, " ").trim();
    if (cleaned.length < 2) continue;
    const params = new URLSearchParams({
      select: "source_key,page_title,content,canonical_url,revision,as_of",
      page_title: `ilike.*${cleaned}*`,
      source_kind: "eq.namu_document",
      as_of: `lte.${now.slice(0, 10)}`,
      limit: "6",
      order: "as_of.desc,source_key.asc,chunk_index.asc",
    });
    const rows = await readRows("genius_rag_serving_chunks", params, signal);
    for (const row of rows) {
      const content = String(row.content ?? "").slice(0, 6000);
      const fingerprint = createHash("sha256").update(JSON.stringify([row.source_key ?? row.article_key, row.revision, content])).digest("hex").slice(0, 24);
      collected.push({ id: `${request.source}:${fingerprint}`, source: request.source,
        title: String(row.title ?? row.page_title ?? ""), content,
        url: String(row.link ?? row.canonical_url ?? ""), asOf: String(row.published_at ?? row.as_of ?? "") });
    }
  }
  return [...new Map(collected.map(e => [e.id, e])).values()].slice(0, 6);
}

async function main() {
  if (!input || typeof input !== "object") throw new Error("invalid input shape");
  const result = await runAgentPoc(input as Parameters<typeof runAgentPoc>[0], {
    search,
    decide: async (system, state, signal) => {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey! },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: JSON.stringify(state) }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 2500 } }),
      });
      if (!response.ok) throw new Error(`model_http_${response.status}`);
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("");
      if (!text) throw new Error("empty_model_response");
      return JSON.parse(text);
    },
  });
  process.stdout.write(JSON.stringify({ experiment: "international-agent-poc-v1", model,
    retrieval: "news_official_vector_wiki_title_lexical", productionServing: false, ...result }, null, 2) + "\n");
  if (result.status === "error") process.exitCode = 1;
}
main().catch(() => { process.stderr.write("PoC failed; credentials and provider response suppressed\n"); process.exitCode = 1; });
