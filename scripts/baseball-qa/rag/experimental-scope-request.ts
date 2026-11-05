import type { RagEvidence, buildRagLlmRequest } from '../../../src/lib/baseball-qa/rag/retrieve';
import type { OfficialEvidenceBundle } from '../../../src/lib/baseball-qa/rag/official-sibling-evidence';
import { OFFICIAL_SIBLING_ANCHOR_BODY_LABEL } from '../../../src/lib/baseball-qa/rag/official-sibling-evidence';
import { officialModelEvidenceContent } from '../../../src/lib/baseball-qa/rag/official-parenthetical-evidence';
import { parseScope, renderScope, sha256, EXTRA_UNITS } from './experimental-scope-spans';

type Request = ReturnType<typeof buildRagLlmRequest>;
const identity = (r: RagEvidence) => JSON.stringify([r.canonicalUrl, r.revision, r.sectionPath]);
export function scopeRequest(base: Request, evidence: RagEvidence[], bundle?: OfficialEvidenceBundle) {
  const trace: { index: number; reason: string; rawContentSha256?: string; relation?: ReturnType<typeof parseScope>['relation'] }[] = [];
  const unchanged = (reason: string) => ({ request: base, applied: 0, addedUnits: 0, trace, reason });
  if (!bundle || JSON.stringify(evidence) !== JSON.stringify(bundle.modelEvidence)) return unchanged('missing-or-mismatched-bundle');
  if (bundle.primaryCount > 6 || bundle.physicalChunkCount > 7 || bundle.trace.length > 1
      || evidence.length !== bundle.primaryCount || bundle.rawEvidence.length !== bundle.physicalChunkCount)
    return unchanged('invalid-physical-budget');
  const before = base.contents[0]?.parts[0]?.text;
  if (typeof before !== 'string') return unchanged('unsupported-payload');
  // Parse only ORIGINAL raw sources, before considering any model bundle string.
  const plans = bundle.rawEvidence.map(raw => ({ raw, parsed: parseScope(raw) }));
  let text = before, applied = 0;
  for (const [index, model] of evidence.entries()) {
    const matches = plans.filter(p => identity(p.raw) === identity(model));
    if (matches.length !== 1) { trace.push({ index, reason: 'ambiguous-identity' }); continue; }
    const {raw, parsed} = matches[0];
    if (raw.sourceKind !== 'kbo_ebook' || raw.sourceGrade !== 'tier1' || !parsed.relation) {
      trace.push({ index, reason: parsed.reason }); continue;
    }
    const rendered = renderScope(raw, parsed.relation);
    const originalView = officialModelEvidenceContent(raw);
    const transformedView = rendered.content + originalView.slice(raw.content.length);
    let oldView = officialModelEvidenceContent(model), newView: string;
    if (model.content === raw.content) newView = transformedView;
    else {
      // Do not parse/rewrite nested sibling JSON or its labels/lead/item spans.
      // Only the exactly bound ORIGINAL anchor suffix can be replaced.
      const suffix = '\n' + OFFICIAL_SIBLING_ANCHOR_BODY_LABEL + '\n' + originalView;
      if (!bundle.trace.some(t => t.anchor === index) || !oldView.endsWith(suffix)) {
        trace.push({ index, reason: 'unrecognized-bundle' }); continue;
      }
      newView = oldView.slice(0, -originalView.length) + transformedView;
    }
    const metadata = JSON.stringify({ evidence: index + 1, documentTitle: model.pageTitle,
      sectionPath: model.sectionPath, collectedAt: model.asOf || null, calendarSeason: model.calendarSeason ?? null });
    const header = `[자료${index + 1}]\n문서 메타데이터: ${metadata}\n본문:\n`;
    const needle = header + oldView;
    const at = text.indexOf(needle);
    if (!rendered.applied || at < 0 || text.indexOf(needle, at + 1) >= 0) {
      trace.push({ index, reason: 'payload-binding-failed' }); continue;
    }
    text = text.slice(0, at) + header + newView + text.slice(at + needle.length);
    applied++;
    trace.push({ index, reason: 'applied', rawContentSha256: sha256(raw.content), relation: parsed.relation });
  }
  if (!applied) return unchanged('no-applicable-span');
  if (applied > 7 || text.length - before.length !== applied * EXTRA_UNITS) return unchanged('render-budget');
  const request = structuredClone(base);
  request.contents[0].parts[0].text = text;
  return {request, applied, addedUnits: text.length - before.length, trace, reason: 'applied'};
}

let active = false;
/** Sequential diagnostic ONLY. The original server still owns URL, auth, timeout,
 * errors, response parsing and the single fetch. Never a second provider client.
 * Require the exact previewed serialized body; unexpected sends stop, not retry.
 */
export async function withScopeTransport<T>(base: Request, candidate: Request, call: () => Promise<T>): Promise<T> {
  if (active) throw new Error('scope transport requires serial execution');
  active = true;
  const originalFetch = globalThis.fetch;
  const expected = JSON.stringify(base), replacement = JSON.stringify(candidate);
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/?]+:generateContent(?:\?|$)/.test(url)
        || init?.method !== 'POST' || init.body !== expected || ++calls !== 1)
      throw new Error('scope transport contract mismatch');
    return originalFetch(input, replacement === expected ? init : {...init, body: replacement});
  };
  try {
    const result = await call();
    if (calls !== 1) throw new Error('scope transport did not observe exactly one call');
    return result;
  } finally { globalThis.fetch = originalFetch; active = false; }
}
