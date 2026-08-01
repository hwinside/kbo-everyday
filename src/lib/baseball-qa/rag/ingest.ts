import { createHash } from "node:crypto";

import {
  missingChunkMetaKeys,
  type RagChunkMeta,
  type RagEntityType,
} from "./contracts";

export const MAX_CHUNK_CHARS = 900;
export const MIN_CHUNK_CHARS = 40;

export function stripWikiMarkup(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\*[^\]]*\]/g, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[[a-zA-Z가-힣]+(\([^)]*\))?\]/g, " ")
    .replace(/^\s*=+\s*(.+?)\s*=+\s*$/gm, "$1")
    .replace(/'''([^']+)'''/g, "$1")
    .replace(/''([^']+)''/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^\s*[>*]+\s?/gm, "")
    .replace(/\|\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkText(clean: string): string[] {
  const paragraphs = clean.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = "";
  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed.length >= MIN_CHUNK_CHARS) chunks.push(trimmed);
    buffer = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARS) {
        buffer = paragraph.slice(offset, offset + MAX_CHUNK_CHARS);
        flush();
      }
      continue;
    }
    if (buffer.length + paragraph.length + 2 > MAX_CHUNK_CHARS) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface IngestSourceDoc {
  entityType: RagEntityType;
  entityId: string;
  pageTitle: string;
  canonicalUrl: string;
  revision: string;
  sectionPath: string;
  crawledAt: string;
  asOf: string;
  rawText: string;
}

export interface PreparedChunk {
  meta: RagChunkMeta;
  content: string;
  contentChars: number;
  documentContentHash: string;
}

export type IngestResult =
  | { ok: true; chunks: PreparedChunk[] }
  | { ok: false; reason: string; missingKeys?: string[] };

export function prepareNamuChunks(doc: IngestSourceDoc): IngestResult {
  const baseMeta: Partial<RagChunkMeta> = {
    ...doc,
    sourceGrade: "tier2",
    contentHash: "placeholder",
  };
  const missing = missingChunkMetaKeys(baseMeta);
  if (missing.length > 0) {
    return { ok: false, reason: "missing_required_meta", missingKeys: missing };
  }

  const clean = stripWikiMarkup(doc.rawText);
  if (!clean) return { ok: false, reason: "empty_after_cleaning" };
  const documentContentHash = contentHash(clean);
  const chunks = chunkText(clean).map((content) => ({
    meta: { ...(baseMeta as RagChunkMeta), contentHash: contentHash(content) },
    content,
    contentChars: content.length,
    documentContentHash,
  }));
  if (chunks.length === 0) return { ok: false, reason: "no_chunk_above_min_length" };

  // 길이 제한은 chunk 저장 단위를 제약할 뿐 원문 보존 최소화를 보장하지 않는다.
  // 원문 선택·보존 정책은 rev0.7 §12.2 제안 확정 뒤 별도 게이트로 결속한다.
  return { ok: true, chunks };
}
