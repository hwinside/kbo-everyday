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
  const aliases: Readonly<Record<string, readonly string[]>> = {
    "레이예스": ["레예스"],
    "벤자민": ["벤저민"],
  };
  if (aliases[seedName]?.includes(title)) return true;
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
  // ⚠️ **길이 상한을 두지 않는다** (2026-08-09 실측 결함).
  //   종전엔 `{0,300}` 이었는데, 분류가 긴 선수는 그 칸을 넘어간다:
  //     `양의지` 분류 428자 — `대한민국의 남자 야구 선수` 가 300자 **밖**에 있어
  //     `not_baseball_player_document` 로 거부됐다. 문서는 정확히 본인 문서다.
  //   훈장·수상이 많은 **베테랑일수록** 분류가 길어져서, 하필 유명 선수가 버려졌다.
  //
  //   상한을 없애도 안전하다 — `[^\n]` 이므로 **줄바꿈에서 자연히 끝난다**. 분류는
  //   한 줄이고 그 줄을 끝까지 읽는 것이 원래 의도였다. 스캔 범위는 `CATEGORY_SCAN_CHARS`
  //   가 여전히 제한한다(본문 중간의 `분류` 글자를 잡지 않는다).
  const matched = /분류([^\n]*)/.exec(head);
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

/** 문서 인포박스의 완전한 생년월일. 분류 라인 뒤 `YYYY년 M월 D일` 로 적힌다. */
export function extractDocumentBirthDate(
  text: string,
): { year: number; month: number; day: number } | undefined {
  // ⚠️ `2002년 데뷔` 처럼 **연도만 있는 항목은 잡히지 않는다**(월·일까지 요구한다).
  //   인포박스의 `출생` 항목이 문서 앞부분의 첫 완전 날짜다.
  const matched = /((?:19|20)\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(text.slice(0, 6_000));
  if (!matched) return undefined;
  return { year: Number(matched[1]), month: Number(matched[2]), day: Number(matched[3]) };
}

/**
 * **해 경계 생년 불일치**가 빠른생일·음력 표기 차이로 설명되는가.
 *
 * ⚠️ 왜 필요한가 (2026-08-09 실측 결함) — 생년 정확 일치만 보면 본인 문서가 거부된다:
 *     최형우   문서 1984년 1월 18일    로스터 1983-12-16   (33일 차)
 *     장성우   문서 1989년 12월 17일   로스터 1990-01-17   (31일 차)
 *     김태혁   문서 1987년 12월 30일   로스터 1988-01-02   (3일 차)
 *   세 명 모두 **같은 사람**이고, KBO 등록과 나무위키 분류가 서로 다른 기준
 *   (반년 빨리 입학한 "빠른생일" · 음력 생일)을 쓴 것뿐이다.
 *
 * ⚠️ 그렇다고 "1년 차이는 허용"으로 느슨하게 하면 **동명이인 형제·부자를 섞는다**.
 *   그래서 근거를 요구한다 — **둘 다 해 경계(12월 또는 1월)에 있고, 실제 날짜 간격이
 *   60일 이내**일 때만 생년만 다른 동일인으로 본다. 달이 중간이면(예: 6월)
 *   빠른생일로 설명되지 않으므로 그대로 거부한다.
 *
 * @param documentBirthDate 문서 본문에서 읽은 생년월일
 * @param rosterBirthDate   로스터 `YYYY-MM-DD`
 */
export function isYearBoundaryBirthDate(
  documentBirthDate: { year: number; month: number; day: number } | undefined,
  rosterBirthDate: string | undefined,
): boolean {
  if (!documentBirthDate || !rosterBirthDate) return false;
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rosterBirthDate);
  if (!parsed) return false;
  const rosterYear = Number(parsed[1]);
  const rosterMonth = Number(parsed[2]);
  // 생년이 정확히 1년 차여야 한다. 2년 이상은 빠른생일로 설명되지 않는다.
  if (Math.abs(documentBirthDate.year - rosterYear) !== 1) return false;
  // 둘 다 해 경계에 있어야 한다 — 이게 빠른생일·음력의 서명이다.
  const boundary = (month: number) => month === 12 || month === 1;
  if (!boundary(documentBirthDate.month) || !boundary(rosterMonth)) return false;
  // 실제 날짜 간격이 60일 이내여야 한다(달만 맞고 날짜가 멀면 다른 사람이다).
  const docTime = Date.UTC(documentBirthDate.year, documentBirthDate.month - 1, documentBirthDate.day);
  const rosterTime = Date.UTC(rosterYear, rosterMonth - 1, Number(parsed[3]));
  return Math.abs(docTime - rosterTime) / 86_400_000 <= 60;
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
  /**
   * 로스터 생년월일 `YYYY-MM-DD`. 있으면 **해 경계 빠른생일** 구제가 활성화된다.
   * 없으면 종전과 똑같이 연도 정확 일치만 본다 — 없는 근거로 통과시키지 않는다.
   */
  rosterBirthDate?: string;
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
  if (!input.rosterBirthYear || !/^\d{4}$/.test(input.rosterBirthYear)) {
    return { ok: false, status: "ambiguous", reason: "roster_birth_year_absent" };
  }
  const birthMatch = matchesBirthYear(categories, input.rosterBirthYear);
  if (birthMatch === null) {
    return { ok: false, status: "ambiguous", reason: "document_birth_year_absent" };
  }
  if (!birthMatch) {
    // ⚠️ 거부 전에 **해 경계 빠른생일**을 한 번 더 본다 (2026-08-09 실측 결함).
    //   최형우·장성우·김태혁은 본인 문서인데 KBO 등록과 나무위키 분류가 기준이 달라
    //   연도가 1 차이로 어긋나 거부됐다. 단, 느슨하게 허용하면 동명이인 형제를 섞으므로
    //   `isYearBoundaryBirthDate` 가 요구하는 근거(둘 다 12/1월 + 실제 간격 60일 이내)를
    //   충족할 때만 구제한다. 근거가 없으면 종전대로 거부다(fail-close 유지).
    const documentBirthDate = extractDocumentBirthDate(input.text);
    if (!isYearBoundaryBirthDate(documentBirthDate, input.rosterBirthDate)) {
      return { ok: false, status: "rejected", reason: "birth_year_mismatch" };
    }
  }

  // 제목 대조 (삼순 NO-GO ①). 생년으로 걸러지지 않는 타인 문서 오귀속을 막는 마지막 방어선이다.
  if (!input.seedName || !input.documentTitle) {
    return { ok: false, status: "ambiguous", reason: "document_title_absent" };
  }
  const matchedTitle = titleMatchesSeed(input.seedName, input.documentTitle);
  if (!matchedTitle) {
    // 다른 선수 문서일 수 있다. 추측해서 귀속하지 않고 격리한다.
    return { ok: false, status: "ambiguous", reason: "document_title_mismatch" };
  }
  return { ok: true, matchedBirthYear: birthMatch === true, matchedTitle };
}
