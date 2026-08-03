/** 야잘알봇 v2 RAG 신뢰성 계약. KBO 수치만 확정값으로 사용한다. */

export type SourceGrade = "tier1" | "tier2";
export type RagSourceKind =
  | "kbo_structured"
  | "namu_document"
  | "wikipedia_document"
  | "kbo_ebook";
export type RagEntityType =
  | "record_category"
  | "league"
  | "team"
  | "player"
  | "document";

export const RAG_EMBEDDING_DIM = 768;

const SOURCE_GRADE_BY_KIND: Record<RagSourceKind, SourceGrade> = {
  kbo_structured: "tier1",
  // KBO 공식 간행물 e북(규칙·규약·규정·연감·레코드북)은 KBO가 발행한 1차 출처다.
  // 위키류와 달리 조문·기록이 정본이므로 tier1이며, 수치 근거로 쓸 수 있다.
  kbo_ebook: "tier1",
  namu_document: "tier2",
  wikipedia_document: "tier2",
};

export function gradeForSourceKind(kind: RagSourceKind): SourceGrade {
  return SOURCE_GRADE_BY_KIND[kind];
}

export function canGroundNumericClaim(grade: SourceGrade): boolean {
  return grade === "tier1";
}

export type NumericVerdict =
  | { decision: "use_official"; value: string; reason: string }
  | { decision: "hold_numeric"; reason: string };

export function resolveNumericConflict(
  officialValue: string | null,
  wikiValue: string | null,
): NumericVerdict {
  if (officialValue !== null && officialValue !== "") {
    const conflicts = wikiValue !== null && wikiValue !== "" && wikiValue !== officialValue;
    return {
      decision: "use_official",
      value: officialValue,
      reason: conflicts ? "conflict_official_wins" : "official_only_or_agree",
    };
  }
  return {
    decision: "hold_numeric",
    reason: wikiValue ? "wiki_value_uncrosschecked" : "no_value_available",
  };
}

export interface RagChunkMeta {
  entityType: RagEntityType;
  entityId: string;
  pageTitle: string;
  canonicalUrl: string;
  revision: string;
  sectionPath: string;
  crawledAt: string;
  contentHash: string;
  sourceGrade: SourceGrade;
  asOf: string;
}

const REQUIRED_CHUNK_META_KEYS: (keyof RagChunkMeta)[] = [
  "entityType",
  "entityId",
  "pageTitle",
  "canonicalUrl",
  "revision",
  "sectionPath",
  "crawledAt",
  "contentHash",
  "sourceGrade",
  "asOf",
];

export function missingChunkMetaKeys(meta: Partial<RagChunkMeta>): string[] {
  return REQUIRED_CHUNK_META_KEYS.filter((key) => {
    const value = meta[key];
    return value === undefined || value === null || value === "";
  });
}
