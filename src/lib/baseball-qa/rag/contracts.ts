/**
 * 야잘알봇 v2 Hybrid RAG — 신뢰성 게이트 계약 (rev0.7 §12 / 제0원칙).
 *
 * 이 파일은 "어떤 소스의 값을 확정 사실로 쓸 수 있는가"를 코드로 고정한다.
 * 스펙 문장이 아니라 이 상수/함수가 런타임 판정의 SSOT다.
 *
 * 핵심 계약 3줄:
 *   1. KBO 기록실(tier1)만 정량(수치) 확정 claim의 정본이다.
 *   2. 나무위키(tier2)는 서술형 참조 전용. 수치는 tier1과 대조되기 전에는 확정 금지.
 *   3. 수치가 충돌하면 KBO를 채택하고, 대조 자체가 불가하면 서술만 쓰고 수치는 보류한다.
 */

/** 소스 신뢰등급. tier1 = KBO 공식(정본), tier2 = 나무위키(서술 참조). */
export type SourceGrade = "tier1" | "tier2";

/** RAG 수집 대상 엔티티 축. */
export type RagEntityType = "league" | "team" | "player" | "record_book";

/** 수집 소스 종류. */
export type RagSourceKind = "kbo_official" | "namuwiki";

/**
 * 인벤토리 분류 상태 (§12: 조용한 누락 금지).
 * pending이 1건이라도 남아 있으면 '전수 완료'라고 표현하지 않는다.
 */
export type InventoryStatus =
  | "resolved"
  | "missing"
  | "ambiguous"
  | "blocked"
  | "pending";

/**
 * 임베딩 모델 — `gemini-embedding-2`.
 *
 * 왜 이 모델인가(삼순 재리뷰 #2 반영): 기존 `text-embedding-004`는 2026-01-14 shutdown되어
 * 현재 API에서 **실제 404**다(2026-07-31 실측: `models/text-embedding-004 is not found for
 * API version v1beta`). 계정에서 `embedContent`를 지원하는 모델은 `gemini-embedding-001`,
 * `gemini-embedding-2-preview`, `gemini-embedding-2` 3종이며 GA 최신인 `gemini-embedding-2`를 쓴다.
 */
export const RAG_EMBEDDING_MODEL = "gemini-embedding-2";

/**
 * 임베딩 차원 — migration의 vector(768)과 반드시 일치(스모크가 drift 차단).
 *
 * `gemini-embedding-2`의 기본 차원은 3072이라 **반드시 outputDimensionality=768을 명시**해야 한다.
 * 명시하지 않으면 3072가 돌아와 vector(768) 컬럼과 어긋난다. 768은 공식 문서가 권장하는
 * 절단 차원(768/1536/3072) 중 하나이고, 768 이하 절단분은 모델이 자동 재정규화한다(공식 문서).
 * 2026-07-31 실측: outputDimensionality=768 요청 → HTTP 200 / values.length=768 / 전건 유한수.
 */
export const RAG_EMBEDDING_DIM = 768;

/** 소스별 신뢰등급 매핑. 이 매핑 밖의 소스는 존재하지 않는다(fail-closed). */
const SOURCE_GRADE_BY_KIND: Record<RagSourceKind, SourceGrade> = {
  kbo_official: "tier1",
  namuwiki: "tier2",
};

export function gradeForSourceKind(kind: RagSourceKind): SourceGrade {
  return SOURCE_GRADE_BY_KIND[kind];
}

/** 정량(수치) 확정 claim을 만들 자격이 있는 등급인가. tier1만 true. */
export function canGroundNumericClaim(grade: SourceGrade): boolean {
  return grade === "tier1";
}

/** 수치 대조 판정 결과. */
export type NumericVerdict =
  /** tier1 값 채택(확정). */
  | { decision: "use_official"; value: string; reason: string }
  /** 대조 불가 → 수치 보류, 서술만 사용. */
  | { decision: "hold_numeric"; reason: string };

/**
 * tier1(KBO) / tier2(나무위키) 수치 대조 게이트.
 *
 * 계약:
 *   - tier1 값이 있으면 언제나 tier1을 채택한다(값이 같든 다르든).
 *   - tier1 값이 없으면 tier2 수치는 확정하지 않는다 — 대조할 정본이 없기 때문.
 *     (§12 "나무위키의 숫자는 공식 소스로 교차확인되기 전 정량 확정값으로 쓰지 않는다")
 *
 * @param officialValue KBO 기록실에서 조회된 값. 미조회/실패면 null.
 * @param wikiValue 나무위키에서 추출된 값. 없으면 null.
 */
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

/** RAG chunk 메타 — §12 필수값. 하나라도 결측이면 서빙 금지. */
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

/**
 * chunk 메타 완결성 검증. 결측 키 목록을 반환하며, 빈 배열이면 통과.
 * 불완전한 메타로 서빙하면 출처·기준시각을 표기할 수 없으므로 fail-closed한다.
 */
export function missingChunkMetaKeys(meta: Partial<RagChunkMeta>): string[] {
  return REQUIRED_CHUNK_META_KEYS.filter((key) => {
    const value = meta[key];
    return value === undefined || value === null || value === "";
  });
}
