/** Offline derived evidence. No rule names, question matching or model calls.
 * Offsets are UTF-16 indices into the EXACT stored chunk, not normalized text.
 * This is a syntactic contract, not a legal/semantic correctness certificate.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const STRUCTURE_VERSION = 'official-parenthetical-v3';
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
      // Scope/qualifier markers and case-marked targets are not item lists.
      // Comma/range coordination is also quoted, never asserted as one item.
      const payloadCandidate = match?.[1].trim() ?? '';
      const quoteOnly = /아니|않|못|다만|경우|외에는|이후|이전|부터|까지|[,;~～]|(?:^|\s)단(?:\s|,|$)/.test(inner)
        || /(?:에서|에게|한테|으로|로|에|보다|처럼|만큼|대해|관해)$/.test(payloadCandidate);
      if (match && !quoteOnly && payloadCandidate) {
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
  // Leading conditional exceptions only. Never infer the inverse consequence.
  // A complete sentence and an explicit sentence/list boundary are required;
  // embedded subjects, unfinished chunks and multiple exceptions stay unannotated.
  const leading = /(?:^|\n|[.!?]\s+)(?:\[[^\]\n]+\]\s*|[⒜-⒵⑴-⒇①-⑳]\s*|\d+\.\s*)?([^\n.!?()[\]]{1,160}?경우)(?:을|를)\s+제외하고(?:는)?\s*,?\s+/g;
  for (const m of content.matchAll(leading)) {
    const conditionStart = m.index + m[0].indexOf(m[1]);
    const conditionEnd = conditionStart + m[1].length;
    const bodyStart = m.index + m[0].length;
    const tail = content.slice(bodyStart);
    const end = /다\.(?=\s|$)/.exec(tail);
    if (!end || end.index > 600) continue;
    const bodyEnd = bodyStart + end.index + 2;
    const body = content.slice(bodyStart, bodyEnd);
    // Do not cross a new provision/annotation or coordinate another exception.
    if (/[\[\]⒜-⒵⑴-⒇①-⑳]|제외|다만/.test(body)
        || /[,;:]|제외|(?:^|\s)\S+(?:은|는)\s+(?!경우)/.test(m[1])
        || /[()]/.test(content.slice(conditionStart, bodyEnd))) continue;
    relations.push({ kind: 'leading-exception',
      parenthetical: span(content, conditionStart, bodyEnd),
      context: span(content, bodyStart, bodyEnd), coordination: 'unsplit',
      items: [span(content, conditionStart, conditionEnd)] });
  }
  // Partial/truncated chunks must never turn an inner fragment into a note.
  return { version: STRUCTURE_VERSION, sourceRevision, contentSha256: hash(content),
    relations: depth || unresolved.some(x => x.reason === 'unmatched-close') ? [] : relations, unresolved };
}

export function renderOfficialParentheticals(content, sourceRevision, structure) {
  // Re-derive the entire contract: forged spans/items and stale revisions fail closed.
  const expected = structureOfficialParentheticals(content, sourceRevision);
  if (!isDeepStrictEqual(expected, structure)) throw new Error('invalid/stale official structure');
  return structure.relations.map(r => {
    if (r.kind === 'leading-exception') return `문장 앞 예외 조건(원문): ${r.items[0].quote}\n`
      + `위 예외 조건을 제외한 경우에만 적용되는 본문(원문): ${r.context.quote}\n`
      + '적용 범위: 위 본문의 조건과 효과를 예외 조건에 그대로 적용하지 않음. 예외 상황의 효과는 이 문장의 반대로 추론하지 않고 별도 원문으로 판단.';
    const context = `괄호 직전 원문(적용 범위는 원문 전체로 판단): ${r.context.quote.trim()}`;
    if (r.kind !== 'exclusion') return `${context}\n단서 원문(분해하지 않음): ${r.parenthetical.quote}`;
    return `${context}\n${r.items.map((item, i) => `괄호 안 제외 항목 ${String.fromCharCode(65 + i)}: ${item.quote}.`).join('\n')}\n`
      + (r.coordination === 'explicit-or' ? '제외 범위: 위 병렬 항목 각각이 제외됨.\n' : '')
      + '나머지 적용 조건과 효과: 위 원문 그대로.';
  }).join('\n');
}
