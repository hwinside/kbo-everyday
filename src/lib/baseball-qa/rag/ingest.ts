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
 *
 * ── 수치 재산정 근거 (R3, 2026-08-01 실문서 실측) ──────────────────────────────
 * R2의 25%/2,700자는 크롤이 막힌 상태에서 정한 **추정값**이었다. 실크롤로 문서 16건을 받아
 * 길이 분포를 실측한 뒤 다음 두 근거로 다시 정한다.
 *
 * (1) 절대 상한 2,400자 = `RAG_EVIDENCE_LIMIT`(4) × `RAG_EVIDENCE_MAX_CHARS`(600).
 *     서빙이 프롬프트에 넣을 수 있는 근거의 총량이 정확히 이 값이다. **이보다 많이 저장해도
 *     한 글자도 서빙에 쓰이지 않는다** — 쓰이지 않는 원문을 보관하는 것이 §12.2(c)가 금지하는 것이다.
 *     따라서 상한을 "서빙이 실제로 소비 가능한 양"에 맞춘다(2,700 → 2,400).
 *
 * (2) 비율 20%. 실측한 선수 문서 정리본 길이는 4,325자(김백산) ~ 31,533자(허경민)이고 중앙값은
 *     약 20,000자다. 20%면 최단 문서에서도 865자(= chunk 1~2건)가 확보되어 리드 문단과
 *     별명 문단이 함께 살아남고, 최장 문서에서는 절대 상한이 걸려 실보존 7.6%에 그친다.
 *     25%로 두면 최장 문서에서 7,883자까지 허용되어 상한이 사실상 유일한 방어선이 된다.
 *
 * 실측 확인: 문보경 문서(정리본 25,009자)에서 별명 서술 문단("대표적인 별명으로 …문보물…")이
 * 상한 안에 보존된다 — 줄이되 답을 깨지 않는다는 것이 이 수치의 조건이다.
 */
export const RETENTION_MAX_RATIO = 0.2;
export const RETENTION_MAX_CHARS = 2_400;
export const ENTITY_RETENTION_MAX_RATIO = 0.1;
export const ENTITY_RETENTION_MAX_CHARS = 12_000;

/**
 * 보존 정책 (하린아빠 2026-08-02 명시 결정 — "저장을 100%해줘", "나무위키도 100%로 해").
 *
 * `"minimal"` = 기존 §12.2(c) 최소 원문저장. 신호 문단만 골라 20%/2,400자 안에서 보존한다.
 * `"full"`    = 정리본 전문을 chunk로 보존한다. **검색 재현율(정확성)을 최우선**으로 둔 정책이다.
 *
 * ── 이 전환에서 바뀌지 않는 것 (중요) ─────────────────────────────────────────
 * **서빙 노출 상한은 그대로다.** 답변 프롬프트에 들어가는 근거는 여전히
 * `RAG_EVIDENCE_LIMIT`(4) × `RAG_EVIDENCE_MAX_CHARS`(600) = 2,400자가 최대다.
 * 즉 이 전환이 키우는 것은 **검색 대상 풀**이지 외부로 나가는 원문량이 아니다.
 * 저장 100% ≠ 노출 100% 이며, 이 성질은 `assertServingExposureUnchanged` 회귀로 잠근다.
 *
 * ── 정직한 기록 ────────────────────────────────────────────────────────────
 * 기존 20%/2,400자는 성능 튜닝이 아니라 **원문 아카이브가 되지 않기 위한 정책 상한**이었다.
 * 이를 푸는 것은 엔지니어링 최적화가 아니라 하린아빠의 정책 결정이며, 근거는
 * "학습용이라 상관없고 답변 정확성이 우선"이다. 코드가 이 결정을 숨기지 않도록 여기 남긴다.
 */
export type RetentionPolicy = "minimal" | "full";
export const RETENTION_POLICY: RetentionPolicy = "full";

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

/**
 * 전문 보존 모드의 chunk 분할.
 *
 * 핵심: 기존 minimal 경로는 긴 문단을 `slice`로 **잘라 버렸다**. 100% 보존에서 같은 방식을 쓰면
 * 900자 넘는 문단의 뒷부분이 조용히 사라져 "100%"가 거짓이 된다. 그래서 자르는 대신
 *   (a) 900자 초과 문단은 **분할**하고
 *   (b) 짧은 문단은 인접 문단과 **묶어** chunk 밀도를 유지한다.
 * 두 경우 모두 문단 텍스트 자체는 한 글자도 버리지 않는다 — `assertFullRetentionLossless`가 잠근다.
 */
export function packFullDocumentChunks(clean: string): string[] {
  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let buffer = "";
  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) chunks.push(trimmed);
    buffer = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      // 긴 문단은 버리지 않고 쪼갠다(자르면 뒷부분이 유실된다).
      flush();
      for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARS) {
        const piece = paragraph.slice(offset, offset + MAX_CHUNK_CHARS).trim();
        if (piece.length > 0) chunks.push(piece);
      }
      continue;
    }
    if (buffer.length > 0 && buffer.length + paragraph.length + 2 > MAX_CHUNK_CHARS) flush();
    buffer = buffer.length > 0 ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return mergeUndersizedChunks(chunks);
}

/**
 * 하한 미달 조각 병합.
 *
 * 문단 단위로 묶다 보면 `== 개요 ==` 같은 짧은 머리 문단이 2자짜리 chunk로 떨어진다.
 * 그런 조각은 검색에 무의미하고 임베딩만 낭비한다. **버리지 않고 이웃과 합쳐서** 하한을 지킨다
 * — 버리면 무손실 계약이 깨진다.
 *
 * 문서 전체가 하한보다 짧은 스텁 문서는 그대로 1건으로 남긴다. 그것이 100% 보존이다.
 */
function mergeUndersizedChunks(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;
  const merged: string[] = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && (previous.length < MIN_CHUNK_CHARS || chunk.length < MIN_CHUNK_CHARS)) {
      const combined = `${previous}\n\n${chunk}`;
      if (combined.length <= MAX_CHUNK_CHARS) {
        merged[merged.length - 1] = combined;
        continue;
      }
      // 합치면 상한을 넘는 경우: 이어 붙인 뒤 절반으로 다시 나눈다.
      // MAX_CHUNK_CHARS(900) >= 2 x MIN_CHUNK_CHARS(40) 이므로 양쪽 모두 하한을 만족한다.
      const half = Math.ceil(combined.length / 2);
      merged[merged.length - 1] = combined.slice(0, half);
      merged.push(combined.slice(half));
      continue;
    }
    merged.push(chunk);
  }
  return merged;
}

export function selectRetrievalSnippets(
  clean: string,
  pageTitle: string,
  policy: RetentionPolicy = RETENTION_POLICY,
): string[] {
  if (policy === "full") return packFullDocumentChunks(clean);
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
    // 섹션 헤더(`== 제목 ==`)를 제목만 남긴다. `\s`는 개행을 포함하므로 `[ \t]`로 좁힌다 —
    // `\s*`를 쓰면 헤더 앞의 빈 줄까지 먹어 **문단 경계가 사라진다**(위키피디아 extract는
    // `\n\n\n== 제목 ==` 형태라 문서 전체가 한 문단으로 뭉쳐 snippet 선별이 무력화됐다).
    .replace(/^[ \t]*=+[ \t]*(.+?)[ \t]*=+[ \t]*$/gm, "$1")
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

export type DocumentSetIngestResult =
  | {
      ok: true;
      chunks: PreparedChunk[];
      documentCount: number;
      cleanChars: number;
      retainedChars: number;
    }
  | { ok: false; reason: string; missingKeys?: string[] };

/**
 * tier2 문서(나무위키·위키피디아 공통)를 저장 가능한 chunk로 준비한다.
 * 두 소스가 **같은 보존 상한·같은 선별 규칙**을 쓴다 — 소스마다 규칙이 갈리면 한쪽에서 전문이 쌓인다.
 */
export function prepareTier2Chunks(
  doc: IngestSourceDoc,
  policy: RetentionPolicy = RETENTION_POLICY,
): IngestResult {
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
  // full 모드에서는 "보존 예산이 작아서 버린다"가 없다 — 스텁 문서도 있는 그대로 보존한다.
  // (minimal 모드에서 위키피디아 310건이 이 사유로 전량 fail-close 됐다.)

  // §12.2(c) 최소 원문저장: 문서 전체를 쪼개지 않고 retrieval에 필요한 snippet만 골라 저장한다.
  const snippets = selectRetrievalSnippets(clean, doc.pageTitle, policy);
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
  // full 정책은 보존 상한 자체가 없다(정의상 전문 보존). 대신 아래 무손실 계약이 방어선이다.
  if (policy !== "full" && retained > retentionBudget(clean.length)) {
    return { ok: false, reason: "retention_budget_exceeded" };
  }
  return { ok: true, chunks };
}

/** entity의 메인+하위문서 전부에 문서별 상한과 **합산 상한**을 이중 적용한다. */
export function prepareTier2DocumentSet(
  documents: IngestSourceDoc[],
  policy: RetentionPolicy = RETENTION_POLICY,
): DocumentSetIngestResult {
  if (documents.length === 0) return { ok: false, reason: "document_set_empty" };

  const cleanChars = documents.reduce((sum, document) => sum + stripWikiMarkup(document.rawText).length, 0);
  // full 모드: entity 합산 상한을 두지 않는다. 상한을 남겨두면 하위문서가 많은 entity(최정 등)에서
  // round-robin 도중 예산이 소진돼 뒷 문서가 통째로 유실되고, 그것은 100% 보존이 아니다.
  const entityBudget = policy === "full"
    ? Number.MAX_SAFE_INTEGER
    : Math.min(ENTITY_RETENTION_MAX_CHARS, Math.floor(cleanChars * ENTITY_RETENTION_MAX_RATIO));
  if (entityBudget < MIN_RETENTION_BUDGET) {
    return { ok: false, reason: "entity_retention_budget_too_small" };
  }

  const preparedByDocument: PreparedChunk[][] = [];
  for (const document of documents) {
    const prepared = prepareTier2Chunks(document, policy);
    if (!prepared.ok) {
      // retrieval 신호가 없는 하위문서는 저장하지 않는 것이 최소 원문저장 계약에 맞다.
      if (prepared.reason === "no_retrievable_snippet_within_retention_budget") continue;
      return prepared;
    }
    preparedByDocument.push(prepared.chunks);
  }
  if (preparedByDocument.length === 0) {
    return { ok: false, reason: "no_retrievable_document_within_entity_budget" };
  }

  // 문서별 첫 근거부터 round-robin. traversal 순서의 첫 문서가 합산 예산을 독점하지 않는다.
  const chunks: PreparedChunk[] = [];
  let retainedChars = 0;
  for (let round = 0; ; round += 1) {
    let pickedInRound = false;
    for (const documentChunks of preparedByDocument) {
      const candidate = documentChunks[round];
      if (!candidate) continue;
      pickedInRound = true;
      const remaining = entityBudget - retainedChars;
      if (remaining < MIN_CHUNK_CHARS) break;
      const content = candidate.content.slice(0, remaining).trim();
      if (content.length < MIN_CHUNK_CHARS) continue;
      chunks.push({
        ...candidate,
        content,
        contentChars: content.length,
        meta: { ...candidate.meta, contentHash: contentHash(content) },
      });
      retainedChars += content.length;
      if (retainedChars >= entityBudget) break;
    }
    if (!pickedInRound || retainedChars >= entityBudget) break;
  }

  if (chunks.length === 0) return { ok: false, reason: "no_chunk_within_entity_retention_budget" };
  if (retainedChars > entityBudget) return { ok: false, reason: "entity_retention_budget_exceeded" };
  return {
    ok: true,
    chunks,
    documentCount: documents.length,
    cleanChars,
    retainedChars,
  };
}
