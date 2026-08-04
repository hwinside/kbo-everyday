import { createHash } from "node:crypto";

export type DocumentSourceKind = "namu_document" | "wikipedia_document";
export type ResolutionStatus = "resolved" | "missing" | "ambiguous" | "blocked";

interface ResolutionSourceInput {
  sourceKey: string;
  sourceKind: DocumentSourceKind;
  entityId: string;
  pageTitle: string;
  candidateUrls: string[];
  canonicalUrl: string | null;
  resolutionStatus: ResolutionStatus;
  resolutionNote: string;
  updatedAt: string;
}

export function buildResolutionSourceRow(input: ResolutionSourceInput) {
  if (input.candidateUrls.length === 0) throw new Error("resolution source requires candidate URLs");
  const identityFingerprint = createHash("sha256").update(JSON.stringify({
    sourceKey: input.sourceKey,
    sourceKind: input.sourceKind,
    entityType: "player",
    entityId: input.entityId,
    pageTitle: input.pageTitle,
    candidateUrls: input.candidateUrls,
    canonicalUrl: input.canonicalUrl,
    resolutionStatus: input.resolutionStatus,
  })).digest("hex");
  return {
    source_key: input.sourceKey,
    source_kind: input.sourceKind,
    entity_type: "player" as const,
    entity_id: input.entityId,
    page_title: input.pageTitle,
    candidate_urls: input.candidateUrls,
    canonical_url: input.canonicalUrl,
    resolution_status: input.resolutionStatus,
    resolution_note: input.resolutionNote,
    source_grade: "tier2" as const,
    identity_fingerprint: identityFingerprint,
    updated_at: input.updatedAt,
  };
}
