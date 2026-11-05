#!/usr/bin/env node
/** Read-only manifest generation. Requires an audited corpus and current serving export. */
import fs from 'node:fs';
import { sha256, enumerationCandidates, bindEnumerationContexts } from './official-enumeration-context.mjs';
const opt = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const servingPath = opt('serving'), corpusPath = opt('corpus'), auditPath = opt('audit'), out = opt('out');
if (!servingPath || !corpusPath || !auditPath || !out) throw new Error('serving, corpus, audit and out required');
const servingRaw = fs.readFileSync(servingPath, 'utf8'), corpusRaw = fs.readFileSync(corpusPath, 'utf8');
const snapshot = JSON.parse(fs.readFileSync(`${servingPath}.snapshot.json`, 'utf8'));
const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
const serving = servingRaw.trim().split('\n').map(JSON.parse), corpus = corpusRaw.trim().split('\n').map(JSON.parse);
if (snapshot.view !== 'genius_rag_serving_chunks' || snapshot.sha256 !== sha256(servingRaw)
  || snapshot.rows !== serving.length) throw new Error('serving snapshot mismatch');
if (audit.outputSha256 !== sha256(corpusRaw) || audit.lostChars !== 0 || !audit.pdfPagesVerified
  || !/^[a-f0-9]{64}$/.test(audit.sourcePdfSha256 ?? '') || audit.chunks !== corpus.length) throw new Error('PDF-verified lossless corpus audit required');
for (const row of serving) {
  const source = snapshot.sourceSnapshots.find(s => s.source_key === row.sourceKey);
  if (row.source !== 'kbo_official' || row.inputKind !== 'serving_chunk'
    || row.rawContentSha256 !== sha256(row.text) || !source || source.tombstoned_at
    || source.active_claim_generation !== row.claimGeneration || source.revision !== row.revision
    || source.canonical_url !== row.canonicalUrl) throw new Error('serving source binding mismatch');
}
const candidates = enumerationCandidates(corpus);
const annotations = bindEnumerationContexts(serving, candidates);
fs.writeFileSync(out, JSON.stringify(annotations, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(`${out}.audit.json`, JSON.stringify({ mode: 'official-sibling-manifest-v1', parserVersion: 1,
  manifestJsonSha256: sha256(JSON.stringify(annotations)),
  corpusSha256: audit.outputSha256, sourcePdfSha256: audit.sourcePdfSha256,
  servingSha256: snapshot.sha256, exportedAt: snapshot.exportedAt,
  candidates: candidates.length, annotatedChunks: annotations.length,
  bindings: annotations.reduce((n, a) => n + a.bindings.length, 0),
  inventory: annotations.map(a => ({ chunkId: a.chunkId, section: a.section, note: a.note })) }, null, 2) + '\n', { flag: 'wx' });
console.log(`Official enumeration manifest: ${candidates.length} candidates, ${annotations.length} bound serving chunks`);
