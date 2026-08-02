/**
 * A17 corpus 문서의 entity 신원 판정.
 *
 * ── 왜 필요한가 (2026-08-02 실측) ──────────────────────────────────────────
 * A17 나무위키 크롤러는 **이름 문자열만 갖고** 문서를 긁는다. 위키피디아 경로(`resolve-rag-urls`)에는
 * 분류·생년 대조 게이트가 있어 오매칭이 0건이었지만, corpus에는 그 게이트가 없다.
 * 실측 결과 선수 루트문서 60건 중 **8건(13%)이 엉뚱한 문서**였다:
 *   - `오스틴`   → 동음이의어 문서(미국 텍사스주 주도 / 자동차 브랜드 / 앨범)
 *   - `강백호`   → 동음이의어 문서(슬램덩크 캐릭터 포함)
 *   - `데이비슨` → 동음이의어(성씨)
 *   - `레이예스`·`네일` → 성씨/영어 단어 문서
 *   - `박재현`·`이재현`·`김진욱` → 동명이인 목록 문서
 * 외국인 선수는 나무위키 문서 제목이 등록명과 달라 특히 자주 어긋난다.
 *
 * 이걸 그대로 적재하면 "오스틴이 누구야?"에 텍사스 주도를 설명하게 된다.
 * 저장을 100%로 올린 목적이 답변 정확성인데 정반대 결과가 된다.
 *
 * ── 계약 ───────────────────────────────────────────────────────────────────
 * 저장은 100%로 하되 **잘못된 entity에 붙이지 않는다.** 판정 불가는 버리는 것이 아니라
 * `ambiguous`로 격리해 서빙에서만 제외한다(수집 자산은 보존).
 *
 * ── HTML 게이트와의 차이 (정직한 한계) ────────────────────────────────────
 * `verifyCanonicalIdentity`는 rel=canonical·최종 URL·분류를 HTML에서 읽는다.
 * corpus에는 HTML이 없고 **정리된 본문 텍스트만** 있으므로 신호가 더 약하다.
 * 따라서 이 게이트는 HTML 게이트를 대체하지 않으며, 애매하면 통과시키지 않는 쪽으로 기운다.
 */

export type CorpusIdentityVerdict =
  | { ok: true; matchedBirthYear: boolean; matchedTitle: boolean }
  | { ok: false; status: "ambiguous" | "rejected"; reason: string };

/** 나무위키 문서 제목 접미사. corpus의 `title`은 `"김도영 - 나무위키"` 형태로 저장된다. */
export function normalizeCorpusTitle(title: string | undefined): string {
  return (title ?? "").replace(/\s*-\s*나무위키\s*$/, "").trim();
}

/**
 * 시드 이름 ↔ 실제 도착한 문서 제목 대조 (삼순 NO-GO ①).
 *
 * 크롤러는 이름으로 검색해 서 링크를 따라가므로 **전혀 다른 선수 문서에 도착할 수 있다.**
 * 분류만 보면 그 문서도 "야구선수"라 통과해버리므로(fail-open) 제목 대조가 별도로 필요하다.
 *
 * 단, 정당한 표기 차이는 거부하면 안 된다(실측):
 *   `레이예스` → `레예스` (등록명 vs 문서명)
 *   `올러`     → `아담 올러` (풀네임 문서)
 * 그래서 "포함 관계"까지는 인정하고, 그마저 아니면 결정하지 않고 `ambiguous`로 격리한다.
 */
export function titleMatchesSeed(seedName: string, documentTitle: string): boolean {
  const title = normalizeCorpusTitle(documentTitle);
  if (title.length === 0) return false;
  if (title === seedName) return true;
  // 풀네임 문서(`아담 올러`)는 등록명(`올러`)을 토큰으로 포함한다.
  if (title.split(/\s+/).includes(seedName)) return true;
  return false;
}

/** 나무위키 문서 머리의 `분류...` 라인. 본문 앞부분에만 나타난다. */
const CATEGORY_SCAN_CHARS = 1_200;

/**
 * 분류 문자열 추출. 나무위키 본문은 `분류` 뒤에 분류명이 공백 없이 이어진다
 * (예: `분류김도영대한민국의 남자 야구 선수2003년 출생...`).
 */
export function extractCorpusCategories(text: string): string {
  const head = text.slice(0, CATEGORY_SCAN_CHARS);
  const matched = /분류([^\n]{0,300})/.exec(head);
  return matched?.[1] ?? "";
}

/** 동음이의/동명이인 목록 문서인지. 이런 문서는 특정 선수 서술이 아니다. */
export function isAmbiguityDocument(categories: string): boolean {
  return categories.includes("동음이의") || categories.includes("동명이인");
}

/** 야구 선수 문서인지. `야구 선수`/`야구선수` 표기 흔들림을 모두 받는다. */
export function hasBaseballPlayerCategory(categories: string): boolean {
  const normalized = categories.replace(/\s+/g, "");
  return normalized.includes("야구선수");
}

/**
 * 생년 대조. 나무위키 분류에는 `2003년 출생` 형태가 들어간다.
 * 로스터 생년이 없으면(외국인 일부) 이 신호는 건너뛴다 — 없는 근거로 거부하지 않는다.
 */
export function matchesBirthYear(categories: string, birthYear: string | undefined): boolean | null {
  if (!birthYear || !/^\d{4}$/.test(birthYear)) return null;
  const years = new Set(Array.from(categories.matchAll(/((?:19|20)\d{2})년\s*출생/g), (m) => m[1]));
  if (years.size === 0) return null;
  return years.has(birthYear);
}

/**
 * corpus 루트 문서 1건의 신원 판정.
 *
 * 순서가 중요하다: **동음이의 판정을 야구분류 판정보다 먼저** 한다.
 * 동음이의 문서에도 야구 항목이 섞여 있어(`강백호`) 야구분류만 보면 통과해버린다.
 */
export function verifyCorpusPlayerIdentity(input: {
  text: string;
  rosterBirthYear?: string;
  seedName?: string;
  documentTitle?: string;
}): CorpusIdentityVerdict {
  const categories = extractCorpusCategories(input.text);
  if (categories.length === 0) {
    return { ok: false, status: "rejected", reason: "category_absent" };
  }
  if (isAmbiguityDocument(categories)) {
    // 버리는 게 아니라 격리한다 — 나중에 진짜 문서를 찾을 단서가 된다.
    return { ok: false, status: "ambiguous", reason: "ambiguity_document" };
  }
  if (!hasBaseballPlayerCategory(categories)) {
    return { ok: false, status: "rejected", reason: "not_baseball_player_document" };
  }
  const birthMatch = matchesBirthYear(categories, input.rosterBirthYear);
  if (birthMatch === false) {
    return { ok: false, status: "rejected", reason: "birth_year_mismatch" };
  }

  // 제목 대조 (삼순 NO-GO ①). 생년으로 걸러지지 않는 타인 문서 오귀속을 막는 마지막 방어선이다.
  // 제목 정보가 없으면 이 검사를 건너뛴다 — 없는 근거로 거부하지 않는다.
  let matchedTitle = false;
  if (input.seedName !== undefined && input.documentTitle !== undefined) {
    matchedTitle = titleMatchesSeed(input.seedName, input.documentTitle);
    if (!matchedTitle) {
      // 다른 선수 문서일 수 있다. 추측해서 귀속하지 않고 격리한다.
      return { ok: false, status: "ambiguous", reason: "document_title_mismatch" };
    }
  }
  return { ok: true, matchedBirthYear: birthMatch === true, matchedTitle };
}
