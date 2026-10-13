/** Read-only diagnostic: exact local ranks vs production RPC, never DB mutations.
 * --manifest=<R0 JSON> --out=<new absolute JSON>. Fixed query budget; no generation.
 * Run on Gateway with protected egress and node --use-env-proxy --import tsx.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { embedText, RAG_EMBEDDING_MODEL } from "../../../src/lib/baseball-qa/rag/embed";
import { RAG_DOCUMENT_CANDIDATE_LIMIT, RAG_DOCUMENT_MAX_DISTANCE } from "../../../src/lib/baseball-qa/rag/retrieve";

const opt = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Binding = { lead: string; item: string; sourceText: string; sourceTextSha256: string; leadStart: number; itemStart: number };
type Annotation = { chunkId: number; sourceKey: string; sourceRevision: string; canonicalUrl: string; section: string; rawContentSha256: string; bindings: Binding[] };
type Chunk = { id: number; source_key: string; claim_generation: number; revision: string; canonical_url: string; section_path: string; content: string; page_title: string; embedding: number[] | string };
const queries = ["플라이아웃", "그건 플라이아웃 아니야?", "포구는 뭐야?", "포구와 플라이아웃은 어떻게 달라?", "인필드 플라이 아웃", "인필드 플라이가 선언되면 타자는 아웃이야?", "인필드 플라이를 떨어뜨리면 타자는 아웃이야?"];
function vector(value: number[] | string): number[] {
  const v = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(v) || !v.length || !v.every(n => typeof n === "number" && Number.isFinite(n))) throw new Error("invalid vector");
  return v;
}
function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) throw new Error("vector dimension mismatch");
  const norm = Math.sqrt(a.reduce((s, n) => s + n*n, 0) * b.reduce((s, n) => s + n*n, 0));
  if (!norm) throw new Error("zero vector");
  return 1 - a.reduce((s, n, i) => s + n*b[i], 0) / norm;
}
async function main() {
  const out = opt("out"), manifestPath = opt("manifest");
  const credential = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!out || !path.isAbsolute(out) || fs.existsSync(out) || !manifestPath
    || !/^oc-sent-v2\./.test(credential ?? "") || !process.env.HTTPS_PROXY) throw new Error("new absolute output, manifest and protected egress required");
  const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("HTTPS origin required");
  const headers = { apikey: credential!, Authorization: `Bearer ${credential}` };
  async function read(table: string, fields: string) {
    const result = [];
    for (let offset = 0;;) {
      const params = new URLSearchParams({entity_type:"eq.document", source_grade:"eq.tier1", select:fields, order:table.endsWith("sources") ? "source_key" : "id", offset:String(offset), limit:"250"});
      const response = await fetch(`${origin.origin}/rest/v1/${table}?${params}`, {headers, signal:AbortSignal.timeout(30000)});
      if (!response.ok) throw new Error(`read ${table} HTTP ${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("invalid rows");
      if (!rows.length) break;
      result.push(...rows); offset += rows.length;
    }
    return result;
  }
  const sourceFields = "source_key,revision,active_claim_generation,canonical_url,tombstoned_at";
  const startedAt = new Date().toISOString();
  const before = await read("genius_rag_sources", sourceFields);
  const chunks: Chunk[] = await read("genius_rag_serving_chunks", "id,source_key,claim_generation,revision,canonical_url,section_path,content,page_title,embedding");
  const manifestBytes = fs.readFileSync(manifestPath, "utf8");
  const annotations: Annotation[] = JSON.parse(manifestBytes);
  if (!Array.isArray(annotations) || annotations.length !== 3) throw new Error("R0 inventory must contain exactly three chunks");
  const vectors = new Map(chunks.map(c => [c.id, vector(c.embedding)]));
  const replacements = [];
  for (const a of annotations) {
    const c = chunks.find(c => c.id === a.chunkId);
    if (!c || c.source_key !== a.sourceKey || c.revision !== a.sourceRevision || c.canonical_url !== a.canonicalUrl || c.section_path !== a.section || hash(c.content) !== a.rawContentSha256) throw new Error("live source differs from audited binding");
    for (const b of a.bindings) {
      if (hash(b.sourceText) !== b.sourceTextSha256 || b.sourceText.slice(b.leadStart, b.leadStart + b.lead.length) !== b.lead || b.sourceText.slice(b.itemStart, b.itemStart + b.item.length) !== b.item || !c.content.replace(/\s/g, "").includes(b.item.replace(/\s/g, ""))) throw new Error("invalid original-text binding");
    }
    const leads = [...new Set(a.bindings.map(b => b.lead))];
    if (leads.length !== 1) throw new Error("mixed lead scope: diagnostic refuses whole-chunk prepend");
    // Diagnostic only: whole-chunk prefix is NOT approved ingestion semantics.
    const text = `${leads[0]}\n${c.content}`;
    const plain = await embedText(c.content, "document", fetch, c.page_title);
    const bound = await embedText(text, "document", fetch, c.page_title);
    if (!plain.ok || !bound.ok) throw new Error("diagnostic document embedding failed");
    replacements.push({ chunk:c, text, plain:plain.vector, bound:bound.vector });
  }
  const rows = [];
  for (const query of queries) {
    const q = await embedText(query, "query");
    if (!q.ok) throw new Error(`query embedding ${q.reason}`);
    const ranked = chunks.map(c => ({id:c.id, section:c.section_path, distance:cosine(q.vector, vectors.get(c.id)!)})).sort((a,b) => a.distance-b.distance || a.id-b.id);
    const response = await fetch(`${origin.origin}/rest/v1/rpc/search_baseball_genius_official_chunks`, {method:"POST", headers:{...headers, "Content-Type":"application/json"}, body:JSON.stringify({p_query_embedding:JSON.stringify(q.vector), p_limit:RAG_DOCUMENT_CANDIDATE_LIMIT, p_max_distance:RAG_DOCUMENT_MAX_DISTANCE}), signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`read-only RPC HTTP ${response.status}`);
    const rpc = await response.json();
    if (!Array.isArray(rpc)) throw new Error("invalid RPC rows");
    const targets = replacements.map(r => {
      const original = ranked.find(x => x.id === r.chunk.id)!;
      const measurement = (v: number[]) => {
        const distance = cosine(q.vector, v);
        // One replacement at a time, original id removed, no duplicate supplement.
        const rank = 1 + ranked.filter(x => x.id !== r.chunk.id && (x.distance < distance || (x.distance === distance && x.id < r.chunk.id))).length;
        return {distance, rank, withinThreshold:distance <= RAG_DOCUMENT_MAX_DISTANCE, candidateEligible:distance <= RAG_DOCUMENT_MAX_DISTANCE && rank <= RAG_DOCUMENT_CANDIDATE_LIMIT};
      };
      return {id:r.chunk.id, section:r.chunk.section_path, stored:{...original, rank:ranked.indexOf(original)+1, withinThreshold:original.distance <= RAG_DOCUMENT_MAX_DISTANCE}, plain:measurement(r.plain), bound:measurement(r.bound)};
    });
    rows.push({query, targets, exactTop12:ranked.slice(0,12), rpc:rpc.map(r => ({section:r.section_path,distance:r.distance,contentSha256:hash(r.content)}))});
  }
  const after = await read("genius_rag_sources", sourceFields);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("source snapshot changed during diagnostic");
  for (const c of chunks) {
    const s = before.find(s => s.source_key === c.source_key);
    if (!s || s.tombstoned_at || s.active_claim_generation !== c.claim_generation || s.revision !== c.revision || s.canonical_url !== c.canonical_url) throw new Error("source-generation mismatch");
  }
  const result = {mode:"read-only-rank-diagnostic-not-QA", startedAt, finishedAt:new Date().toISOString(), model:RAG_EMBEDDING_MODEL, chunks:chunks.length, manifestSha256:hash(manifestBytes), sourceSnapshot:before, corpusVectorHash:hash(JSON.stringify(chunks)), threshold:RAG_DOCUMENT_MAX_DISTANCE, candidateLimit:RAG_DOCUMENT_CANDIDATE_LIMIT, embeddingCalls:replacements.length*2+queries.length, replacements:replacements.map(r => ({id:r.chunk.id, section:r.chunk.section_path, originalSha256:hash(r.chunk.content), boundSha256:hash(r.text), boundText:r.text})), rows};
  fs.writeFileSync(out, JSON.stringify(result,null,2), {flag:"wx",mode:0o600});
  console.log(`Read-only diagnostic saved: ${chunks.length} chunks, ${queries.length} queries, ${result.embeddingCalls} embedding calls; no DB writes or answer generation.`);
}
main().catch(() => { console.error("Read-only diagnostic failed; no DB writes. Check protected environment, source bindings and endpoint availability."); process.exitCode=1; });
