/** R1 model-input experiment only. No src imports this module. */
import { createHash } from "node:crypto";
import { officialModelEvidenceContent } from "../../../src/lib/baseball-qa/rag/official-parenthetical-evidence";
import type { RagEvidence } from "../../../src/lib/baseball-qa/rag/retrieve";

export type EnumerationBinding = { section: string; lead: string; item: string;
  sourceText: string; sourceTextSha256: string; leadStart: number; itemStart: number };
export type SiblingManifest = { canonicalUrl: string; sourceRevision: string;
  rawContentSha256: string; section: string; bindings: EnumerationBinding[] };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const compact = (s: string) => s.replace(/\s+/g, "");
const article = (s: string) => compact(s).match(/^\d{1,2}\.\d{2}(?!\d)/)?.[0];
const identity = (r: RagEvidence) => JSON.stringify([r.canonicalUrl,r.revision,r.sectionPath]);
const official = (r: RagEvidence) => r.sourceKind === "kbo_ebook" && r.sourceGrade === "tier1";

export function validateSiblingManifest(manifest: SiblingManifest[]) {
  if (!Array.isArray(manifest)) throw new Error("invalid sibling manifest");
  const seen = new Set<string>();
  for (const m of manifest) {
    const key = JSON.stringify([m.canonicalUrl,m.sourceRevision,m.section]);
    if (!m.canonicalUrl || !m.sourceRevision || !m.section || seen.has(key)
      || !/^[a-f0-9]{64}$/.test(m.rawContentSha256) || !Array.isArray(m.bindings)
      || !m.bindings.length) throw new Error("invalid/ambiguous sibling identity");
    seen.add(key);
    for (const b of m.bindings) {
      if (!b.lead || !b.item || !article(b.section) || hash(b.sourceText) !== b.sourceTextSha256
        || !Number.isInteger(b.leadStart) || b.leadStart < 0 || !Number.isInteger(b.itemStart) || b.itemStart < 0
        || b.sourceText.slice(b.leadStart,b.leadStart+b.lead.length) !== b.lead
        || b.sourceText.slice(b.itemStart,b.itemStart+b.item.length) !== b.item)
        throw new Error("invalid sibling source spans");
    }
  }
}

/** Preserve six primary records byte-for-byte; append at most one independently numbered
 * sibling record at the end. This is seven physical chunks, NOT proof of a six-chunk serving contract.
 * Only an already retrieved, source-bound complete item is eligible. Never fetch/pin p60.
 */
export function siblingEvidence(selected: RagEvidence[], candidates: RagEvidence[], manifest: SiblingManifest[]) {
  const trace: { anchor: number; candidate: number; section: string; addedChars: number }[] = [];
  const modelEvidence = [...selected];
  const selectedIds = new Set(selected.map(identity));
  for (const [rank, sibling] of candidates.entries()) {
    if (!official(sibling) || selectedIds.has(identity(sibling))) continue;
    const matches = manifest.filter(m => m.canonicalUrl === sibling.canonicalUrl
      && m.sourceRevision === sibling.revision && m.section === sibling.sectionPath
      && m.rawContentSha256 === hash(sibling.content));
    if (matches.length !== 1) continue;
    const m = matches[0];
    if (!article(sibling.content) || m.bindings.some(b => article(b.section) !== article(sibling.content)
      || !compact(sibling.content).includes(compact(b.item)))) continue;
    const anchor = selected.findIndex(r => official(r) && r.canonicalUrl === sibling.canonicalUrl
      && r.revision === sibling.revision && article(r.content) === article(sibling.content));
    if (anchor < 0) continue;
    const relations = m.bindings.map(b => ({section:b.section, lead:b.lead,item:b.item}));
    const block = `\n[동일 조항의 검색된 형제 청크 — 별도 원문, 위 자료의 페이지가 아님]\n${JSON.stringify({
      canonicalUrl:sibling.canonicalUrl,revision:sibling.revision,sectionPath:sibling.sectionPath,
      rawContentSha256:m.rawContentSha256,content:officialModelEvidenceContent(sibling),relations})}\n[형제 청크 끝]`;
    if (block.length > 1800) continue; // skip, never truncate a rule or displace primary evidence
    // R1 changes placement only: retain R0 eligibility, payload and global budget.
    // Its own metadata/source identity now belongs to the new final evidence record.
    modelEvidence.push({...sibling,content:block});
    trace.push({anchor,candidate:rank,section:sibling.sectionPath,addedChars:block.length});
    break; // fixed global one-sibling budget; RPC order only
  }
  return {modelEvidence,trace,primaryCount:selected.length,physicalChunkCount:selected.length+trace.length};
}
