import sidecar from "./official-parenthetical-sidecar.json";
import { annotationContentDigest, renderOfficialParentheticals } from "./official-parenthetical-structure.mjs";
import type { RagEvidence } from "./retrieve";

// Generated offline from the serving snapshot, never a question/rule allowlist.
// Original retrieved evidence remains the only input to guards and provenance.
const key = (url: string, revision: string, digest: string) => JSON.stringify([url, revision, digest]);
const index = new Map(sidecar.map(a => [key(a.canonicalUrl, a.sourceRevision, a.contentSha256), a]));

export function officialParentheticalNote(row: RagEvidence): string {
  if (row.sourceGrade !== "tier1" || row.sourceKind !== "kbo_ebook" || !row.revision) return "";
  const annotation = index.get(key(row.canonicalUrl, row.revision, annotationContentDigest(row.content)));
  if (!annotation) return "";
  try {
    // Exact content hash, offsets, revision and parser version must still agree.
    // Render validated spans; do not trust the sidecar's pre-rendered note field.
    const note = renderOfficialParentheticals(row.content, row.revision, annotation.structure);
    return note.length <= 8192 ? note : "";
  } catch {
    // A stale sidecar drops ONLY the annotation, never the original evidence.
    return "";
  }
}

export function officialModelEvidenceContent(row: RagEvidence): string {
  const note = officialParentheticalNote(row);
  return note ? `${row.content}\n[원문 구조화 주석 — 파생 데이터]\n${note}` : row.content;
}
