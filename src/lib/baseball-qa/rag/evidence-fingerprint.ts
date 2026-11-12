import { createHash } from "node:crypto";
import type { RagEvidence } from "./retrieve";

export interface EvidenceFingerprint {
  chunkId: string;
  /** App hash of RPC-returned bytes before downstream projection, not DB attestation. */
  sourceContentSha256: string;
  /** App hash of selected evidence bytes; may equal source hash when unchanged. */
  contentSha256: string;
}

export function contentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Strict allowlist at persistence/replay boundaries; never copy arbitrary payload fields. */
export function readEvidenceFingerprints(value: unknown): EvidenceFingerprint[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const result: EvidenceFingerprint[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object"
      || typeof item.chunkId !== "string" || !/^[1-9][0-9]{0,18}$/.test(item.chunkId)
      || typeof item.sourceContentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceContentSha256)
      || typeof item.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.contentSha256)) return null;
    result.push({ chunkId: item.chunkId, sourceContentSha256: item.sourceContentSha256, contentSha256: item.contentSha256 });
  }
  return result;
}

/** Only complete identity sets are observed. Legacy/mixed evidence stays unknown. */
export function fingerprintEvidence(evidence?: readonly RagEvidence[]): EvidenceFingerprint[] | null {
  if (!evidence?.length) return null;
  return readEvidenceFingerprints(evidence.map(row => ({
    chunkId: row.chunkId,
    sourceContentSha256: row.sourceContentSha256,
    contentSha256: contentSha256(row.content),
  })));
}
