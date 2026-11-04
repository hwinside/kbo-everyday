import notes from "./official-rule-interpretations.json";
import { annotationContentDigest } from "./official-parenthetical-structure.mjs";
import type { RagEvidence } from "./retrieve";

// Editorial interpretations, NOT official quotations or additional grounding.
// Reviewed alongside their exact PDF/revision. No question routing or fallback
// matching: changed, truncated or unrelated evidence gets no interpretation.
const key = (url: string, revision: string, digest: string) => JSON.stringify([url, revision, digest]);
const index = new Map(notes.map(note => [key(note.canonicalUrl, note.sourceRevision, note.contentSha256), note]));

export function officialRuleInterpretation(row: RagEvidence): string {
  if (row.sourceGrade !== "tier1" || row.sourceKind !== "kbo_ebook" || !row.revision) return "";
  const note = index.get(key(row.canonicalUrl, row.revision, annotationContentDigest(row.content)));
  if (!note) return "";
  return `[편집 해석 — 공식 원문과 구분되는 파생 참고자료]\n${note.interpretation}\n`
    + `[동일 revision의 관련 조항 인용 — 새 수치 검증 근거로 사용하지 않음]\n${note.sourceQuotes.join("\n")}`;
}
