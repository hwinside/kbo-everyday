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
// Data label naming where the anchor record's own page text begins, so the sibling
// block above it is not read as part of the same page. Not an instruction to the model.
export const OFFICIAL_SIBLING_ANCHOR_BODY_LABEL = "[이 자료의 본문 시작]";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const compact = (s: string) => s.replace(/\s+/g, "");
const article = (s: string) => compact(s).match(/^\d{1,2}\.\d{2}(?!\d)/)?.[0];
const identity = (r: RagEvidence) => JSON.stringify([r.canonicalUrl,r.revision,r.sectionPath]);
const official = (r: RagEvidence) => r.sourceKind === "kbo_ebook" && r.sourceGrade === "tier1";
/** Official rulebook structural markers: circled/parenthesised item numbers, sub-item
 * letters and bracketed labels. A continuation page whose body carries none of these
 * opens mid-sentence, so it has no identifiable position inside the article.
 * The ASCII "(A)" form must start a line: inline "(c)" is a cross-reference such as
 * "7. 02(c) 참조", not an item of the page the anchor sits on. */
const ANCHOR_UNIT_MARKER = /[\u2474-\u2487\u2170-\u217f\u2160-\u216f\u3260-\u327f\u2460-\u2473\u249c-\u24b5]|(?:^|\n)[ \t]*\([A-Za-z]\)|\[(?:부기|주|예|원주|참고|벌칙)/u;
/** Map an offset in the whitespace-stripped view back onto the raw string. */
function rawOffsetAfterCompact(content: string, compactLength: number) {
  let seen = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (!/\s/.test(content[i] as string)) seen += 1;
    if (seen === compactLength) return i + 1;
  }
  return content.length;
}
/** Drop the article number header ("5.09" in "5.09 아 웃 (이어짐)") and inspect the rest.
 * Served pages are not guaranteed to put the header on its own line, so cut at the
 * `article()` match instead of at the first newline. */
export function anchorCarriesStructuralUnit(content: string) {
  const header = article(content);
  const body = header ? content.slice(rawOffsetAfterCompact(content, header.length)) : content;
  return ANCHOR_UNIT_MARKER.test(body);
}

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
    // The sibling completes an enumeration **at the anchor's position**. A dangling
    // continuation fragment has no such position, so binding there would replace the
    // primary record's meaning instead of supplementing it (#1526 P1 regression).
    const anchor = selected.findIndex(r => official(r) && r.canonicalUrl === sibling.canonicalUrl
      && r.revision === sibling.revision && article(r.content) === article(sibling.content)
      && anchorCarriesStructuralUnit(r.content));
    if (anchor < 0) continue;
    // The lead is what tells the model which rule the item belongs under. Buried inside
    // a serialised `relations` array at the tail of an anchor record it was read as
    // metadata, so a standalone turn quoted the item and never stated the rule it
    // completes (flyout P0). Render the original order as plain text at the head of the
    // block: lead first, then the item it governs, then the sibling chunk itself.
    // Exposure is unchanged — same section/lead/item spans, same sibling content.
    const relations = m.bindings.map(b => `${b.section}\n${b.lead}\n${b.item}`).join("\n\n");
    // #1532 R1 P1: the block now precedes the anchor body, so a label saying "위 자료"
    // pointed at nothing, and the anchor body began with no marker at all. Name the
    // positions the reader actually sees. These are data labels, not instructions.
    const block = `\n[동일 조항의 검색된 형제 청크 — 아래 본문과는 별도 원문이며 같은 페이지가 아님]\n[원문 열거 구조 — 머리말이 먼저, 그 다음이 그 머리말에 속한 항목]\n${relations}\n[형제 청크 원문]\n${JSON.stringify({
      canonicalUrl:sibling.canonicalUrl,revision:sibling.revision,sectionPath:sibling.sectionPath,
      rawContentSha256:m.rawContentSha256,content:officialModelEvidenceContent(sibling)})}\n[형제 청크 끝]`;
    if (block.length > OFFICIAL_SIBLING_BLOCK_MAX_CHARS) continue; // skip, never truncate a rule or displace primary evidence
    // #1532 R0 showed the lead reaching the model in plain text and still losing: the
    // anchor page `#p62` opens with `[부기] 인필드 플라이 규칙이 적용되는 경우를 제외하고
    // … 타자는 아웃이 되 지 않는다`, and the answer follows that exception sentence as if
    // it were the rule. In the document the clause itself comes first and the 부기
    // qualifies it; a continuation page inverts that order. Put the retrieved clause
    // back in front of the annotation it qualifies instead of after it.
    modelEvidence[anchor] = {...selected[anchor],content:block.replace(/^\n/,"")
      +`\n${OFFICIAL_SIBLING_ANCHOR_BODY_LABEL}\n`+officialModelEvidenceContent(selected[anchor])};
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

/** Request-structure gate only. Context turns keep the #1521 path; recordbook requests
 * keep the record-selection contract, where a seventh rule chunk could be offered as a
 * record row. Both skip the extension and return the baseline evidence unchanged. */
export type SiblingSkipReason = "context" | "recordbook" | null;
export type OfficialEvidenceBundle = ReturnType<typeof siblingEvidence>
  & { skippedForContext: boolean; skipReason: SiblingSkipReason };

export function standaloneSiblingEvidence(selected: RagEvidence[], candidates: RagEvidence[],
  manifest: SiblingManifest[], extras?: RagRequestExtras): OfficialEvidenceBundle {
  const skipReason: SiblingSkipReason = extras?.context != null ? "context"
    : extras?.recordbookRequest ? "recordbook" : null;
  if (skipReason) return {
    modelEvidence: selected, rawEvidence: selected, guardEvidence: selected, trace: [], primaryCount: selected.length,
    physicalChunkCount: selected.length, skippedForContext: skipReason === "context", skipReason,
  };
  return {...siblingEvidence(selected, candidates, manifest), skippedForContext: false, skipReason: null};
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

export function prepareOfficialEvidence(selected: RagEvidence[], candidates: RagEvidence[], extras?: RagRequestExtras): OfficialEvidenceBundle {
  return standaloneSiblingEvidence(selected, candidates, servingManifest, extras);
}
