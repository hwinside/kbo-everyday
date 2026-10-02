#!/usr/bin/env node
/** Offline sidecar from an exported serving snapshot. Never mutates source metadata.
 * --corpus=<serving JSONL> --out=<new JSON>
 * Full unserved corpus text is deliberately rejected, not labelled serving evidence.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { annotationContentDigest, structureOfficialParentheticals, renderOfficialParentheticals } from './official-parenthetical-structure.mjs';
const opt = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const corpus = opt('corpus'), out = opt('out');
if (!corpus || !out) throw new Error('serving corpus and out required');
const hash = s => createHash('sha256').update(s).digest('hex');
const raw = fs.readFileSync(corpus, 'utf8');
const snapshot = JSON.parse(fs.readFileSync(`${corpus}.snapshot.json`, 'utf8'));
const rows = raw.trim().split('\n').map(line => JSON.parse(line));
if (snapshot.view !== 'genius_rag_serving_chunks' || snapshot.sha256 !== hash(raw) || snapshot.rows !== rows.length) throw new Error('invalid serving snapshot');
const annotations = [], report = [];
for (const row of rows) {
  if (row.source !== 'kbo_official' || row.inputKind !== 'serving_chunk' || typeof row.text !== 'string'
      || row.rawContentSha256 !== hash(row.text) || !row.revision || !row.canonicalUrl) throw new Error('bound serving chunk required');
  const source = snapshot.sourceSnapshots.find(s => s.source_key === row.sourceKey);
  if (!source || source.tombstoned_at || source.active_claim_generation !== row.claimGeneration || source.revision !== row.revision || source.canonical_url !== row.canonicalUrl) throw new Error('source snapshot mismatch');
  const structure = structureOfficialParentheticals(row.text, row.revision);
  const note = renderOfficialParentheticals(row.text, row.revision, structure);
  report.push({ id: row.id, sourceKey: row.sourceKey, section: row.section, relations: structure.relations.length,
    explicitOr: structure.relations.filter(r => r.coordination === 'explicit-or').length, unresolved: structure.unresolved });
  if (note) annotations.push({ canonicalUrl: row.canonicalUrl, contentSha256: annotationContentDigest(row.text),
    sourceRevision: row.revision, sourceKey: row.sourceKey, chunkId: row.id, claimGeneration: row.claimGeneration,
    note, structure, section: row.section });
}
fs.writeFileSync(out, JSON.stringify(annotations, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(`${out}.report.json`, JSON.stringify({ snapshotSha256: snapshot.sha256, exportedAt: snapshot.exportedAt,
  rows: rows.length, annotated: annotations.length, report }, null, 2) + '\n', { flag: 'wx' });
console.log(`Offline sidecar: ${rows.length} serving chunks; ${annotations.length} annotated; ${out}`);
