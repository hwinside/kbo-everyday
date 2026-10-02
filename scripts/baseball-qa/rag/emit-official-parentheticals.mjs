#!/usr/bin/env node
/** Offline ingestion artifact / reviewer replay manifest. No DB/API access.
 * --corpus=<JSONL> --canonical-url=<verified URL> --out=<JSON>
 * Source-bound replay uses the existing --annotations option. No hand-written notes.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { structureOfficialParentheticals, renderOfficialParentheticals } from './official-parenthetical-structure.mjs';
const opt = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const corpus = opt('corpus'), out = opt('out'), canonicalUrl = opt('canonical-url');
if (!corpus || !out || !canonicalUrl || new URL(canonicalUrl).protocol !== 'https:') throw new Error('corpus, HTTPS canonical-url and out required');
const hash = s => createHash('sha256').update(s).digest('hex');
const raw = fs.readFileSync(corpus, 'utf8');
const sourceRevision = `corpus-sha256:${hash(raw)}`;
const rows = raw.trim().split('\n').map(line => JSON.parse(line));
const annotations = [], report = [];
for (const row of rows) {
  if (row.source !== 'kbo_official' || typeof row.text !== 'string') throw new Error('official corpus text required');
  const structure = structureOfficialParentheticals(row.text, sourceRevision);
  const note = renderOfficialParentheticals(row.text, sourceRevision, structure);
  report.push({ section: row.section, page: row.page, relations: structure.relations.length, unresolved: structure.unresolved });
  if (note) annotations.push({ canonicalUrl, contentSha256: hash(row.text.replace(/\s+/g, ' ').trim()),
    note, structure, section: row.section, page: row.page });
}
fs.writeFileSync(out, JSON.stringify(annotations, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(`${out}.report.json`, JSON.stringify({ sourceRevision, rows: rows.length, annotated: annotations.length, report }, null, 2) + '\n', { flag: 'wx' });
console.log(`Offline only: ${rows.length} chunks; ${annotations.length} annotated; ${out}`);
