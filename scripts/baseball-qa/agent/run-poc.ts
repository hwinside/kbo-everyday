/** CLI only. Input is an anonymized ConversationInput JSON file; stdout is local evidence, never a DM. */
import { rankNews, searchWiki, toEvidence, newsPageParams } from "./search-adapters";
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

async function readNewsCandidates(now: string, signal: AbortSignal) {
  const rows: Record<string, unknown>[] = [];
  // Time predicates are applied on the server BEFORE paging/ranking. Never top-k then filter.
  for (let offset = 0; offset <= 10000; offset += 250) {
    const page = await readRows("genius_news_articles", newsPageParams(now, offset), signal);
    if (offset === 10000 && page.length) throw new Error("news_candidate_budget_exceeded");
    rows.push(...page);
    if (page.length < 250) return rows;
  }
  throw new Error("news_candidate_budget_exceeded");
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
    if (request.source === "news") {
      const rows = await readNewsCandidates(now, signal);
      return rankNews(rows, vector, now).map(row => toEvidence(row, "news"));
    }
    const rpc = "search_baseball_genius_official_chunks";
    const args = { p_query_embedding: JSON.stringify(vector), p_limit: 6, p_max_distance: 0.42 };
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
  return searchWiki(request.terms, now, signal, readRows);

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
