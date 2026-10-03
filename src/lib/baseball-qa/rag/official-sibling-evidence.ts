/** Official serving: six primary chunks plus at most one source-bound sibling. */
import manifestAudit from "./official-sibling-manifest.audit.json";
import manifestData from "./official-sibling-manifest.json";
import { RAG_EVIDENCE_LIMIT } from "./retrieve";
import { createHash } from "node:crypto";
import { officialModelEvidenceContent } from "./official-parenthetical-evidence";
import type { RagEvidence, RagRequestExtras } from "./retrieve";

export type EnumerationBinding = { section: string; lead: string; item: string;
  sourceText: string; sourceTextSha256: string; leadStart: number; itemStart: number };
export type SiblingManifest = { canonicalUrl: string; sourceRevision: string;
  rawContentSha256: string; section: string; bindings: EnumerationBinding[] };
export const OFFICIAL_PHYSICAL_EVIDENCE_LIMIT = 7;
export const OFFICIAL_SIBLING_BLOCK_MAX_CHARS = 1800;
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

/** Preserve six primary records byte-for-byte; append at most one separately labelled
 * sibling block. Serving contract: six primary slots, at most seven physical chunks.
 * Only an already retrieved, source-bound complete item is eligible. Never fetch/pin p60.
 */
export function siblingEvidence(selected: RagEvidence[], candidates: RagEvidence[], manifest: SiblingManifest[]) {
  if (selected.length > RAG_EVIDENCE_LIMIT || selected.length + 1 > OFFICIAL_PHYSICAL_EVIDENCE_LIMIT) throw new Error("primary evidence exceeds six");
  const rawEvidence = [...selected];
  const guardEvidence = [...selected];
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
    if (block.length > OFFICIAL_SIBLING_BLOCK_MAX_CHARS) continue; // skip, never truncate a rule or displace primary evidence
    modelEvidence[anchor] = {...selected[anchor],content:officialModelEvidenceContent(selected[anchor])+block};
    rawEvidence.push(sibling);
    // Ground only the raw sibling and the exact validated lead/item spans shown
    // to the model. Never ground metadata, annotations or the full corpus row.
    guardEvidence.push({...sibling, content: sibling.content + "\n" +
      m.bindings.map(b => `${b.lead}\n${b.item}`).join("\n")});
    trace.push({anchor,candidate:rank,section:sibling.sectionPath,addedChars:block.length});
    break; // fixed global one-sibling budget; RPC order only
  }
  return {modelEvidence,rawEvidence,guardEvidence,trace,primaryCount:selected.length,physicalChunkCount:selected.length+trace.length};
}

/** R3: request-structure gate only. Keep R0 unchanged for the B control. */
export function standaloneSiblingEvidence(selected: RagEvidence[], candidates: RagEvidence[],
  manifest: SiblingManifest[], extras?: RagRequestExtras) {
  if (extras?.context != null) return {
    modelEvidence: selected, rawEvidence: selected, guardEvidence: selected, trace: [], primaryCount: selected.length,
    physicalChunkCount: selected.length, skippedForContext: true,
  };
  return {...siblingEvidence(selected, candidates, manifest), skippedForContext: false};
}

// Invalid bundled artifacts disable only the extension, never baseline evidence.
const servingManifest: SiblingManifest[] = (() => {
  try {
    if (manifestAudit.mode !== "official-sibling-manifest-v1" || manifestAudit.parserVersion !== 1
      || manifestAudit.manifestJsonSha256 !== hash(JSON.stringify(manifestData))) return [];
    validateSiblingManifest(manifestData); return manifestData;
  }
  catch { return []; }
})();

export function prepareOfficialEvidence(selected: RagEvidence[], candidates: RagEvidence[], extras?: RagRequestExtras) {
  return standaloneSiblingEvidence(selected, candidates, servingManifest, extras);
}
