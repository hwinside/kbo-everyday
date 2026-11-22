/** #1536 scripts-only renderer: unchanged parser, closed boundaries, no new prose. */
import { parseScope, type Source, type Relation } from './experimental-scope-spans';
export const CLOSED_TAGS = ['<예외절 원문>', '</예외절 원문>', '<적용 본문 원문>', '</적용 본문 원문>'] as const;
export const CLOSED_EXTRA_UNITS = CLOSED_TAGS.reduce((sum, tag) => sum + tag.length, 0);
export const BOUNDARY_CONTRACT = {
  version: 'scope-boundary-v1', designSha: '7b52745f6464f4e8b07257924cfff85c675895a7',
  holdComparison: 'semantic-correct-GROUNDED-count-per-suite-raw-and-final',
  general: 'report-only-not-rag-recovery; loss-to-hold-reported-without-rep-causality',
  firstStageMaxCalls: 154, totalMaxCalls: 484, primaryLimit: 6, physicalLimit: 7,
  extraUtf16PerSpan: CLOSED_EXTRA_UNITS, extraUtf16PerRequest: 6 * CLOSED_EXTRA_UNITS,
} as const;
export function renderClosedScope(source: Source, relation: Relation) {
  const fallback = (reason: string) => ({content: source.content, applied: false, reason});
  if (CLOSED_TAGS.some(tag => source.content.includes(tag))) return fallback('tag-collision');
  const fresh = parseScope(source).relation;
  if (!fresh || JSON.stringify(fresh) !== JSON.stringify(relation)) return fallback('stale-or-invalid-relation');
  const [start, end] = relation.sentence, split = relation.connective[1];
  const E = source.content.slice(...relation.excludedScope) + source.content.slice(...relation.connective);
  const G = source.content.slice(...relation.governedClause);
  if (E + G !== source.content.slice(start, end) || E !== source.content.slice(start, split))
    return fallback('non-lossless-spans');
  const [openE, closeE, openG, closeG] = CLOSED_TAGS;
  return {content: source.content.slice(0, start) + openE + E + closeE + openG + G + closeG
    + source.content.slice(end), applied: true, reason: 'applied'};
}
