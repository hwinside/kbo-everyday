/**
 * 야잘알봇 v2 Hybrid RAG — ingestion 스캐폴드 (rev0.7 §12).
 *
 * 파이프라인: 크롤 → 정제(위키 마크업 제거) → 청킹 → 임베딩 → 저장.
 * 이 파일은 그중 **순수 변환 단계(정제·청킹·메타 생성)**만 담는다.
 * 네트워크 크롤과 대량 임베딩 실행은 이 슬라이스 범위 밖이다(스캐폴드 + 소량 스모크만).
 *
 * ⚠️ 스케줄러 제약(P0): 이 파이프라인의 배치 실행은 GitHub Actions 또는 Vercel cron으로만
 * 구동한다. 맥미니 LaunchAgent/crontab 신규 등록 금지. 워크플로 파일 추가는 하린아빠
 * 명시 승인 대상이라 이 슬라이스에는 포함하지 않는다.
 *
 * ⚠️ 저작권(§5, §12.2-b): 나무위키는 CC BY-NC. 원문 장문 복제를 피하고 retrieval에
 * 필요한 최소 chunk만 보존하며 답변은 재서술 + canonical 출처 링크로 낸다.
 * 그래서 chunk 길이에 상한(MAX_CHUNK_CHARS)을 두고 문서 전문 저장을 구조적으로 막는다.
 */

import { createHash } from "node:crypto";
import {
  missingChunkMetaKeys,
  type RagChunkMeta,
  type RagEntityType,
  type SourceGrade,
} from "./contracts";

/**
 * chunk 최대 길이. retrieval 품질(문단 단위 맥락)과 원문 장문 보존 회피의 절충값.
 * 이 상한을 넘는 텍스트는 잘리는 게 아니라 여러 chunk로 분할된다.
 */
export const MAX_CHUNK_CHARS = 900;
/** 이보다 짧은 조각은 문맥이 없어 retrieval 노이즈만 만들므로 버린다. */
export const MIN_CHUNK_CHARS = 40;

/**
 * 나무위키 마크업 제거 → 재서술 가능한 평문.
 *
 * 제거 대상(보수적으로 잘 알려진 문법만):
 *   - 각주 `[* ...]`, 매크로 `[각주]` `[br]` 등 대괄호 명령
 *   - 링크 `[[대상|표시]]` → 표시 텍스트
 *   - 강조 `'''bold'''` `''italic''`, 취소선 `~~...~~`, 밑줄 `__...__`
 *   - 인용/표 기호 줄머리, 문단 헤더 `== 제목 ==`
 *   - HTML 태그, HTML 주석
 *
 * 모르는 문법은 건드리지 않는다(과도한 제거로 사실이 훼손되는 쪽이 더 위험).
 */
export function stripWikiMarkup(raw: string): string {
  let text = raw;

  // HTML 주석 / 태그
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<[^>]+>/g, " ");

  // 각주: [* 내용] / [*a 내용] — 중첩 대괄호는 다루지 않는다(보수적).
  text = text.replace(/\[\*[^\]]*\]/g, " ");

  // 링크: [[대상|표시]] → 표시, [[대상]] → 대상
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");

  // 매크로: [br], [각주], [목차], [include(...)] 등 단일 대괄호 명령
  text = text.replace(/\[[a-zA-Z가-힣]+(\([^)]*\))?\]/g, " ");

  // 문단 헤더: == 제목 == → 제목
  text = text.replace(/^\s*=+\s*(.+?)\s*=+\s*$/gm, "$1");

  // 강조/장식
  text = text.replace(/'''([^']+)'''/g, "$1");
  text = text.replace(/''([^']+)''/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");

  // 줄머리 기호(인용 >, 목록 *, 표 ||)
  text = text.replace(/^\s*[>*]+\s?/gm, "");
  text = text.replace(/\|\|/g, " ");

  // 공백 정규화
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/** 문단 경계를 지키면서 MAX_CHUNK_CHARS 이하로 분할. */
export function chunkText(clean: string): string[] {
  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed.length >= MIN_CHUNK_CHARS) chunks.push(trimmed);
    buffer = "";
  };

  for (const paragraph of paragraphs) {
    // 단일 문단이 상한을 넘으면 문장 단위로 쪼갠다.
    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush();
      const sentences = paragraph.split(/(?<=[.!?。])\s+/);
      for (const sentence of sentences) {
        if (buffer.length + sentence.length + 1 > MAX_CHUNK_CHARS) flush();
        // 문장 하나가 상한을 넘는 극단 케이스는 하드 분할.
        if (sentence.length > MAX_CHUNK_CHARS) {
          for (let i = 0; i < sentence.length; i += MAX_CHUNK_CHARS) {
            buffer = sentence.slice(i, i + MAX_CHUNK_CHARS);
            flush();
          }
          continue;
        }
        buffer = buffer ? `${buffer} ${sentence}` : sentence;
      }
      flush();
      continue;
    }

    if (buffer.length + paragraph.length + 2 > MAX_CHUNK_CHARS) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();

  return chunks;
}

/** 증분 재수집(§12)의 변경 감지 키. 같은 내용이면 같은 해시 → upsert no-op. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface IngestSourceDoc {
  entityType: RagEntityType;
  entityId: string;
  pageTitle: string;
  canonicalUrl: string;
  /** 나무위키 revision(문서 판) 또는 KBO 스냅샷 식별자. 없으면 ingest 거부. */
  revision: string;
  sectionPath: string;
  sourceGrade: SourceGrade;
  crawledAt: string;
  asOf: string;
  rawText: string;
}

export interface PreparedChunk {
  meta: RagChunkMeta;
  content: string;
  contentChars: number;
}

export type IngestResult =
  | { ok: true; chunks: PreparedChunk[] }
  /** 메타 결측 등으로 ingest 거부. 조용히 부분 저장하지 않는다(fail-closed). */
  | { ok: false; reason: string; missingKeys?: string[] };

/**
 * 문서 1건 → 저장 가능한 chunk 목록.
 * 메타가 하나라도 결측이면 거부한다 — 출처·기준시각 표기 불가 상태로 서빙되면 제0원칙 위반.
 */
export function prepareChunks(doc: IngestSourceDoc): IngestResult {
  const baseMeta: Partial<RagChunkMeta> = {
    entityType: doc.entityType,
    entityId: doc.entityId,
    pageTitle: doc.pageTitle,
    canonicalUrl: doc.canonicalUrl,
    revision: doc.revision,
    sectionPath: doc.sectionPath,
    crawledAt: doc.crawledAt,
    sourceGrade: doc.sourceGrade,
    asOf: doc.asOf,
    contentHash: "placeholder", // chunk별로 실제 해시가 채워진다.
  };

  const missing = missingChunkMetaKeys(baseMeta);
  if (missing.length > 0) {
    return { ok: false, reason: "missing_required_meta", missingKeys: missing };
  }

  const clean = stripWikiMarkup(doc.rawText);
  if (clean.length === 0) {
    return { ok: false, reason: "empty_after_cleaning" };
  }

  const chunks = chunkText(clean).map<PreparedChunk>((content) => ({
    meta: { ...(baseMeta as RagChunkMeta), contentHash: contentHash(content) },
    content,
    contentChars: content.length,
  }));

  if (chunks.length === 0) {
    return { ok: false, reason: "no_chunk_above_min_length" };
  }

  return { ok: true, chunks };
}
