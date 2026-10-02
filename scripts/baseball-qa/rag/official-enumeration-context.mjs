/** Offline experiment: join complete enumeration items to their audited lead.
 * Not a production parser or serving corpus replacement. No rule/question list.
 */
import { createHash } from 'node:crypto';
export const sha256 = text => createHash('sha256').update(text).digest('hex');
const compact = text => text.replace(/\s+/g, '');
const article = text => compact(text).match(/^\d{1,2}\.\d{2}/)?.[0];

export function enumerationCandidates(rows) {
  const found = new Map();
  for (const row of rows) {
    if (row.source !== 'kbo_official' || row.unit !== 'complete_rule' || !row.atomic) continue;
    const marker = row.section.match(/\/[ ]*([⑴-⒇])$/)?.[1];
    const newline = row.text.indexOf('\n');
    if (!marker || newline < 0) continue;
    const body = row.text.slice(newline + 1);
    const start = body.indexOf(marker);
    // Require an explicit complete declarative lead, not a inferred caption.
    const lead = body.slice(0, start).trim();
    if (start < 0 || !lead || !/[다요]\.$/.test(lead) || lead.length > 240) continue;
    const item = body.slice(start).split(/\[(?:원주|주\d*|예\d*|문|답|부기|규칙설명)\]|\n/)[0].trim();
    if (item.length < 15 || item.length > 700 || /[⑴-⒇]/.test(item.slice(1))) continue;
    const key = JSON.stringify([row.title, row.section, lead, item]);
    if (!found.has(key)) found.set(key, { title: row.title, section: row.section, lead, item,
      sourceText: row.text, sourceTextSha256: sha256(row.text), page: row.page,
      leadStart: newline + 1 + body.indexOf(lead), itemStart: newline + 1 + start });
  }
  return [...found.values()];
}

export function bindEnumerationContexts(serving, candidates) {
  const annotations = [];
  for (const row of serving) {
    const title = row.section.split('#')[0];
    const matches = candidates.filter(c => c.title === title && article(c.section) === article(row.text)
      && article(c.section) && compact(row.text).includes(compact(c.item)));
    // A repeated item under conflicting scopes is ambiguous; do not choose one.
    const safe = matches.filter(c => !matches.some(other => compact(c.item) === compact(other.item)
      && (c.lead !== other.lead || c.section !== other.section)));
    const bindings = safe.filter(c => !compact(row.text).includes(compact(c.lead)));
    if (!bindings.length) continue;
    const note = bindings.map(c => `원문 열거 관계 (${c.section}, PDF p${c.page}):\n머리말: ${c.lead}\n그 머리말에 속한 항목: ${c.item}`).join('\n');
    if (note.length > 4096) continue;
    annotations.push({ canonicalUrl: row.canonicalUrl, sourceRevision: row.revision,
      contentSha256: sha256(compact(row.text)), rawContentSha256: sha256(row.text),
      section: row.section, sourceKey: row.sourceKey, chunkId: row.id, bindings, note });
  }
  return annotations;
}
