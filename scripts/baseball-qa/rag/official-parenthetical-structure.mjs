/** Offline derived evidence. No rule names, question matching or model calls.
 * Offsets are UTF-16 indices into the EXACT stored chunk, not normalized text.
 * This is a syntactic contract, not a legal/semantic correctness certificate.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const STRUCTURE_VERSION = 'official-parenthetical-v1';
export const annotationContentDigest = text => hash(text.replace(/\s+/g, ''));
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const span = (text, start, end) => ({ start, end, quote: text.slice(start, end) });

export function structureOfficialParentheticals(content, sourceRevision) {
  if (typeof content !== 'string' || typeof sourceRevision !== 'string' || !sourceRevision) {
    throw new Error('content and source revision required');
  }
  const relations = [];
  const unresolved = [];
  let start = -1, depth = 0, nested = false;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '(') {
      if (depth++ === 0) { start = i; nested = false; } else nested = true;
    } else if (content[i] === ')') {
      if (depth === 0) { unresolved.push({ reason: 'unmatched-close', at: i }); continue; }
      if (--depth !== 0) continue;
      const inner = content.slice(start + 1, i);
      if (nested) { unresolved.push({ reason: 'nested', ...span(content, start, i + 1) }); continue; }
      // Explicit terminal exclusion only; negative/conditional exclusions are NOT inferred.
      const match = /^(.*?)(?:은|는)?\s*제외\s*$/.exec(inner);
      const contextStart = Math.max(content.lastIndexOf('\n', start - 1), content.lastIndexOf('. ', start - 1)) + 1;
      const context = span(content, contextStart, start);
      if (match && !/아니|않|못|다만|경우|외에는/.test(inner) && match[1].trim()) {
        const payload = match[1].trim();
        const offset = start + 1 + inner.indexOf(payload);
        // Split one explicit OR only when the first arm is a single noun token.
        // Shared predicates, commas, AND and multiple ORs remain an unsplit quote.
        const arms = payload.split(/\s+또는\s+/);
        const canSplit = arms.length === 2 && /^[가-힣A-Za-z]+$/.test(arms[0])
          && !/[,;]|\s(?:및|그리고|또는)\s/.test(arms[1]);
        const items = canSplit ? [span(content, offset, offset + arms[0].length),
          span(content, offset + payload.lastIndexOf(arms[1]), offset + payload.length)]
          : [span(content, offset, offset + payload.length)];
        relations.push({ kind: 'exclusion', parenthetical: span(content, start, i + 1), context,
          coordination: canSplit ? 'explicit-or' : 'unsplit', items });
      } else if (/제외|다만|단,|경우|한하여|한한다|한함/.test(inner)) {
        // Preserve a qualifier as one quotation, without inventing its logical scope.
        relations.push({ kind: 'qualifier-quote', parenthetical: span(content, start, i + 1), context,
          coordination: 'unsplit', items: [span(content, start + 1, i)] });
      }
    }
  }
  if (depth) unresolved.push({ reason: 'unmatched-open', at: start });
  // Partial/truncated chunks must never turn an inner fragment into a note.
  return { version: STRUCTURE_VERSION, sourceRevision, contentSha256: hash(content),
    relations: depth || unresolved.some(x => x.reason === 'unmatched-close') ? [] : relations, unresolved };
}

export function renderOfficialParentheticals(content, sourceRevision, structure) {
  // Re-derive the entire contract: forged spans/items and stale revisions fail closed.
  const expected = structureOfficialParentheticals(content, sourceRevision);
  if (!isDeepStrictEqual(expected, structure)) throw new Error('invalid/stale official structure');
  return structure.relations.map(r => {
    const context = `괄호 직전 원문(적용 범위는 원문 전체로 판단): ${r.context.quote.trim()}`;
    if (r.kind !== 'exclusion') return `${context}\n단서 원문(분해하지 않음): ${r.parenthetical.quote}`;
    return `${context}\n${r.items.map((item, i) => `괄호 안 제외 항목 ${String.fromCharCode(65 + i)}: ${item.quote}.`).join('\n')}\n`
      + (r.coordination === 'explicit-or' ? '제외 범위: 위 병렬 항목 각각이 제외됨.\n' : '')
      + '나머지 적용 조건과 효과: 위 원문 그대로.';
  }).join('\n');
}
