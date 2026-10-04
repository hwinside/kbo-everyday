/** Scripts-only, reject-only experiment. No question, rule-name or page routing. */
import { createHash } from 'node:crypto';
export const PARSER_VERSION = 'scope-spans-v2';
export const SCOPE_LABEL = '[예외절 원문]';
export const BODY_LABEL = '[적용 본문 원문]';
export const EXTRA_UNITS = SCOPE_LABEL.length + BODY_LABEL.length + 1;
export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export type Source = { canonicalUrl: string; revision: string; sectionPath: string; content: string };
type Span = [number, number];
export type Relation = {
  canonicalUrl: string; revision: string; sectionPath: string; rawContentSha256: string;
  parserVersion: typeof PARSER_VERSION; sentence: Span; excludedScope: Span;
  connective: Span; governedClause: Span;
};
export type ParseResult = { relation?: Relation; reason: string };

/** Only complete declarative Korean sentences and narrowly supported leading scopes.
 * Boundary markers delimit source text; they are not eligibility page/rule lists.
 * Past-tense narrative/nominal subtraction and ambiguous topic clauses stay unchanged.
 */
export function parseScope(source: Source): ParseResult {
  const c = source.content;
  if (!source.canonicalUrl || !source.revision || !source.sectionPath) return { reason: 'missing-identity' };
  if (c.includes(SCOPE_LABEL) || c.includes(BODY_LABEL)) return { reason: 'already-labelled' };
  const all = [...c.matchAll(/제외하고/g)];
  if (all.length !== 1) return { reason: all.length ? 'multiple-scopes' : 'no-marker' };
  const markers = [...c.matchAll(/[을를]\s*제외하고(?![는도])/g)];
  if (markers.length !== 1) return { reason: 'unsupported-connective' };
  const m = markers[0], at = m.index!, split = at + m[0].length;
  // A PDF linebreak is not a sentence boundary. Never trim/normalize the source.
  const prefix = c.slice(0, at);
  const boundaries = [...prefix.matchAll(/다\.[ \t\r\n]+|\[(?:부기|주\d*)\][ \t\r\n]*|(?:^|\n)[⑴-⒇①-⑳⒜-⒵][ \t\r\n]*|(?:^|\n)[ \t]*(?:[-*][ \t]+|[·•][ \t]*)/g)];
  let start = boundaries.length ? boundaries.at(-1)!.index! + boundaries.at(-1)![0].length : 0;
  // A numeric citation belongs to the preceding sentence; preserve it outside spans.
  const citation = c.slice(start, at).match(/^\s*\([0-9][0-9.⒜-⒵⑴-⒇\s]*\)\s*/);
  if (citation) start += citation[0].length;
  while (/\s/.test(c[start] ?? '') && start < at) start++;
  const ending = /다\.(?=\s|$)/g;
  ending.lastIndex = split;
  const endMatch = ending.exec(c);
  if (!endMatch) return { reason: 'incomplete-sentence' };
  const end = endMatch.index + endMatch[0].length;
  const scope = c.slice(start, at), body = c.slice(split, end);
  if (!scope || !body.trim() || end - start > 780) return { reason: 'empty-or-budget' };
  if (/[\[\]“”"‘’]/.test(scope + body) || /[()]/.test(scope)) return { reason: 'nested-or-quoted' };
  // Latin transliterations in the governed clause are data, not nested conditions.
  const withoutGloss = body.replace(/\([A-Za-z][A-Za-z\s-]*\)/g, '');
  if (/[()⑴-⒇①-⑳⒜-⒵]/.test(withoutGloss)) return { reason: 'nested-or-enumeration' };
  // Deliberately narrow grammar, not a domain noun whitelist. Conditional '경우'
  // or a present-adnominal modifier followed by its single nominal scope only.
  const conditional = /경우\s*$/.test(scope);
  // An unanchored suffix match confuses a topic N+는 with a verb modifier,
  // and a word ending in 이 with a subject. Support only a leading nominative
  // subject, zero or more case-marked complements, then V-는 + nominal head.
  // This is deliberately incomplete grammar; uncertain structures stay raw.
  const subject = scope.match(/^([가-힣]+)(이|가)\s+/);
  const hasFinalConsonant = subject ? (subject[1].charCodeAt(subject[1].length - 1) - 0xac00) % 28 !== 0 : false;
  const nominative = Boolean(subject && (subject[2] === '이' ? hasFinalConsonant : !hasFinalConsonant));
  const modifier = subject ? scope.slice(subject[0].length) : '';
  const adnominal = nominative && /^(?:[가-힣]+(?:에게|에서|으로|를|을|에|로)\s+)*[가-힣]+는\s+[가-힣]+(?:\s+[가-힣]+)*$/.test(modifier);
  if (!conditional && !adnominal) return { reason: 'unsupported-leading-scope' };
  // A complete source sentence, not a heading/paragraph tail pulled into the scope.
  if (/[.!?;:]/.test(scope.replace(/\d+(?:\.\d+)+/g, '')) || scope.length > 240)
    return { reason: 'ambiguous-boundary' };
  return { reason: 'candidate', relation: {
    canonicalUrl: source.canonicalUrl, revision: source.revision, sectionPath: source.sectionPath,
    rawContentSha256: sha256(c), parserVersion: PARSER_VERSION,
    sentence: [start, end], excludedScope: [start, at], connective: [at, split], governedClause: [split, end],
  } };
}

/** Re-derive and compare the complete contract. Tampering never removes raw evidence. */
export function renderScope(source: Source, relation: Relation): { content: string; applied: boolean; reason: string } {
  const fallback = (reason: string) => ({ content: source.content, applied: false, reason });
  const fresh = parseScope(source).relation;
  if (!fresh || JSON.stringify(fresh) !== JSON.stringify(relation)) return fallback('stale-or-invalid-relation');
  const [start, end] = relation.sentence, split = relation.connective[1];
  const original = source.content.slice(start, end);
  const joined = source.content.slice(...relation.excludedScope) + source.content.slice(...relation.connective)
    + source.content.slice(...relation.governedClause);
  if (joined !== original) return fallback('non-lossless-spans');
  return { content: source.content.slice(0, start) + SCOPE_LABEL + source.content.slice(start, split)
    + '\n' + BODY_LABEL + source.content.slice(split), applied: true, reason: 'applied' };
}
