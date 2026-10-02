#!/usr/bin/env node
/** Read-only serving-view snapshot for offline ingestion sidecars.
 * Gateway protected egress only: node --use-env-proxy ... --out=<new JSONL>
 * No embed, source claims, refresh, metadata writes, or mutations.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
const origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
const credential = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!out || !origin || !/^oc-sent-v2\./.test(credential ?? '') || !process.env.HTTPS_PROXY) throw new Error('protected egress, public URL and out required');
const url = new URL(origin);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('HTTPS origin required');
const hash = text => createHash('sha256').update(text).digest('hex');
async function read(table, select, order) {
  const all = [];
  for (let offset = 0;;) {
    const query = new URLSearchParams({ source_kind: 'eq.kbo_ebook', select, order, offset: String(offset), limit: '500' });
    const response = await fetch(`${url.origin}/rest/v1/${table}?${query}`, { headers: { apikey: credential, Authorization: `Bearer ${credential}` } });
    if (!response.ok) throw new Error(`read-only export ${table} HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('invalid rowset');
    if (!rows.length) break;
    all.push(...rows); offset += rows.length;
  }
  return all;
}
const sourceFields = 'source_key,revision,active_claim_generation,canonical_url,tombstoned_at';
const before = await read('genius_rag_sources', sourceFields, 'source_key');
const chunks = await read('genius_rag_serving_chunks', 'id,source_key,claim_generation,revision,canonical_url,section_path,content,source_grade', 'id');
const after = await read('genius_rag_sources', sourceFields, 'source_key');
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('source snapshot changed during export');
const rows = chunks.map(chunk => {
  const source = before.find(s => s.source_key === chunk.source_key);
  if (!source || source.tombstoned_at || source.active_claim_generation !== chunk.claim_generation || source.revision !== chunk.revision || source.canonical_url !== chunk.canonical_url || chunk.source_grade !== 'tier1') throw new Error('serving snapshot binding mismatch');
  return { source: 'kbo_official', inputKind: 'serving_chunk', id: chunk.id, sourceKey: chunk.source_key,
    claimGeneration: chunk.claim_generation, revision: chunk.revision, canonicalUrl: chunk.canonical_url,
    section: chunk.section_path, text: chunk.content, rawContentSha256: hash(chunk.content) };
});
const bytes = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(out, bytes, { flag: 'wx', mode: 0o600 });
fs.writeFileSync(`${out}.snapshot.json`, JSON.stringify({ exportedAt: new Date().toISOString(), view: 'genius_rag_serving_chunks', sourceSnapshots: before, rows: rows.length, sha256: hash(bytes) }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`Read-only serving export: ${rows.length} chunks / ${new Set(rows.map(r => r.sourceKey)).size} sources`);
