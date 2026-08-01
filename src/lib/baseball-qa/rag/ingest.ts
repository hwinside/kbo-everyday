import { createHash } from "node:crypto";

import {
  missingChunkMetaKeys,
  type RagChunkMeta,
  type RagEntityType,
} from "./contracts";

export const MAX_CHUNK_CHARS = 900;
export const MIN_CHUNK_CHARS = 40;

/**
 * 최소 원문저장 계약 (spec rev0.7 §12.2 c).
 *
 * chunk 길이 제한만으로는 "원문 전문 미저장"이 성립하지 않는다 — 문서 전체를 900자씩 쪼개면
 * 조각을 이어 붙여 원문 100%가 그대로 재구성된다. 따라서 보존량 자체에 상한을 둔다:
 *   - 정리된 원문 길이의 `RETENTION_MAX_RATIO` 이하
 *   - 동시에 절대 상한 `RETENTION_MAX_CHARS` 이하 (긴 문서에서 비율만으로는 보존량이 커지므로)
 * 그리고 저장 대상을 "문서 전체"가 아니라 retrieval에 필요한 **서술 snippet**으로 선별한다.
 */
export const RETENTION_MAX_RATIO = 0.25;
export const RETENTION_MAX_CHARS = 2_700;
/** 보존 예산이 이보다 작으면 저장 가능한 chunk(최소 40자) 자체가 나오지 않는다. */
export const MIN_RETENTION_BUDGET = MIN_CHUNK_CHARS;

/**
 * 서술형 retrieval에 쓸모 있는 문단 신호.
 * 이번 슬라이스가 답하는 질문(별명·포지션·소속·데뷔·소개)과 직결된 문단만 남긴다.
 */
const RETRIEVAL_SIGNAL_WORDS = [
  "별명", "별칭", "애칭", "닉네임", "불린다", "불린", "리는",
  "포지션", "내야수", "외야수", "투수", "포수", "유격수", "지명타자",
  "소속", "구단", "팀", "입단", "데뷔", "지명", "이적", "트레이드",
  "출신", "고등학교", "중학교", "초등학교", "프로필", "선수", "평가", "스타일",
];

/**
 * retrieval에 필요한 snippet만 선별한다 (원문 전수 저장 금지, §12.2 c).
 *
 * 선별은 (1) 리드 문단 → (2) 서술 신호 문단 → 그외 순이며, 보존 예산을 초과하는 순간
 * 수집을 멈춘다. 결과는 문서 순서로 돌려주되, 임의의 문서에서 전문이 재구성될 수 없다.
 */
export function retentionBudget(cleanLength: number): number {
  return Math.min(RETENTION_MAX_CHARS, Math.floor(cleanLength * RETENTION_MAX_RATIO));
}

export function selectRetrievalSnippets(clean: string, pageTitle: string): string[] {
  const budget = retentionBudget(clean.length);
  if (budget < MIN_RETENTION_BUDGET) return [];

  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length >= MIN_CHUNK_CHARS);
  if (paragraphs.length === 0) return [];

  const title = pageTitle.normalize("NFC").trim();
  const scored = paragraphs.map((text, index) => {
    let score = 0;
    if (index === 0) score += 3; // 리드 문단은 entity 정의문이라 서술형 답변의 기본 근거다.
    if (title && text.includes(title)) score += 2;
    for (const word of RETRIEVAL_SIGNAL_WORDS) {
      if (text.includes(word)) score += 1;
    }
    return { text, index, score };
  });

  const picked: { text: string; index: number }[] = [];
  let used = 0;
  for (const entry of [...scored].sort((left, right) => right.score - left.score || left.index - right.index)) {
    if (entry.score === 0) continue; // 신호 없는 문단은 retrieval에 불필요 — 저장하지 않는다.
    const remaining = budget - used;
    if (remaining < MIN_CHUNK_CHARS) break;
    const snippet = entry.text.slice(0, Math.min(MAX_CHUNK_CHARS, remaining)).trim();
    if (snippet.length < MIN_CHUNK_CHARS) continue;
    picked.push({ text: snippet, index: entry.index });
    used += snippet.length;
  }
  return picked.sort((left, right) => left.index - right.index).map(({ text }) => text);
}

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

  // §12.2(c) 최소 원문저장: 문서 전체를 쪼개지 않고 retrieval에 필요한 snippet만 골라 저장한다.
  const snippets = selectRetrievalSnippets(clean, doc.pageTitle);
  if (snippets.length === 0) return { ok: false, reason: "no_retrievable_snippet_within_retention_budget" };

  const chunks = snippets.map((content) => ({
    meta: { ...(baseMeta as RagChunkMeta), contentHash: contentHash(content) },
    content,
    contentChars: content.length,
    documentContentHash,
  }));

  // 보존 상한은 반드시 저장 직전에 다시 확인한다 — 선별 로직이 어떤 이유로 예산을 넘기면
  // 그것은 원문 전문 저장으로 가는 길이므로 저장하지 않고 fail-close 한다.
  const retained = chunks.reduce((sum, chunk) => sum + chunk.contentChars, 0);
  if (retained > retentionBudget(clean.length)) {
    return { ok: false, reason: "retention_budget_exceeded" };
  }
  return { ok: true, chunks };
}
