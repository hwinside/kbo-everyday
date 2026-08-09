/**
 * A17 corpus 문서의 entity 신원 판정.
 *
 * ── 왜 필요한가 (2026-08-02 실측) ──────────────────────────────────────────
 * A17 나무위키 크롤러는 **이름 문자열만 갖고** 문서를 긁는다. 위키피디아 경로(`resolve-rag-urls`)에는
 * 분류·생년 대조 게이트가 있어 오매칭이 0건이었지만, corpus에는 그 게이트가 없다.
 * 실측 결과 선수 루트문서 60건 중 **8건(13%)이 엉뚱한 문서**였다:
 *   - `오스틴`   → 동음이의어 문서(미국 텍사스주 주도 / 자동차 브랜드 / 앨범)
 *   - `강백호`   → 동음이의어 문서(슬램덩크 캐릭터 포함)
 *   - `레이예스` → 성씨 문서
 * 이걸 그대로 적재하면 "오스틴이 누구야?"에 텍사스 주도를 설명하게 된다.
 *
 * ── 계약 ───────────────────────────────────────────────────────────────────
 * 저장은 100%로 하되 **잘못된 entity에 붙이지 않는다.** 판정 불가는 버리는 것이 아니라
 * `ambiguous`로 격리해 서빙에서만 제외한다(수집 자산은 보존).
 *
 * ── 이 파일이 다루는 두 가지 실측 레이아웃 ─────────────────────────────────
 * corpus는 수집 시점에 따라 **서로 다른 두 레이아웃**으로 저장돼 있다
 * (2026-08-09, 선수 루트 631건 실측: inline 219 · listed 411 · 분류 없음 1):
 *
 *   inline  `분류김도영대한민국의 남자 야구 선수2003년 출생2022년 데뷔…`  (한 줄, 구분자 없음)
 *   listed  `분류\n장성우\n대한민국의 야구 선수\n1989년 출생\n2009년 데뷔\n…`  (라벨 1줄씩)
 *
 * 종전 코드는 `분류([^\n]*)` 하나로만 읽어 **listed 411건을 전부 `category_absent`로 버렸다**
 * (`분류` 바로 뒤가 줄바꿈이라 캡처가 빈 문자열). 즉 실 corpus의 65%가 신원 판정조차 못 받고
 * 격리돼 있었다. 두 레이아웃을 각각의 경계 규칙으로 읽는 것이 이 파일의 핵심이다.
 */

export type CorpusIdentityVerdict =
  | { ok: true; matchedBirthYear: boolean; matchedTitle: boolean; birthEvidence: BirthEvidence }
  | { ok: false; status: "ambiguous" | "rejected"; reason: string };

/** 생년 통과 근거. `roster_stated_in_document`는 등록일 자체가 문서에 적혀 있던 경우다. */
export type BirthEvidence = "category_year_match" | "roster_date_stated_in_document";

export type CorpusCategoryLayout = "inline" | "listed" | "absent" | "unparseable";

/** 나무위키 문서 제목 접미사. corpus의 `title`은 `"김도영 - 나무위키"` 형태로 저장된다. */
export function normalizeCorpusTitle(title: string | undefined): string {
  return (title ?? "").replace(/\s*-\s*나무위키\s*$/, "").trim();
}

/**
 * 시드 이름 ↔ 실제 도착한 문서 제목 대조.
 *
 * 크롤러는 이름으로 검색해서 링크를 따라가므로 **전혀 다른 선수 문서에 도착할 수 있다.**
 * 분류만 보면 그 문서도 "야구선수"라 통과해버리므로(fail-open) 제목 대조가 별도로 필요하다.
 *
 * 단, 정당한 표기 차이는 거부하면 안 된다(실측):
 *   `레이예스` → `레예스` (등록명 vs 문서명) / `올러` → `아담 올러` (풀네임 문서)
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

/**
 * 문서 머리에서 `분류` 줄을 찾는 스캔 범위(줄 수).
 * 실측 631건의 `분류` 줄 위치는 최대 19번째 줄이다. 본문 중간에 우연히 나오는 `분류`를
 * 잡지 않도록 여유를 조금만 둔다.
 */
const CATEGORY_HEAD_LINES = 40;

/**
 * listed 레이아웃에서 라벨 블록이 이어질 수 있는 최대 줄 수.
 * 실측 411건의 라벨 개수는 p50 12 · p95 18 · **max 44**(축구 국가대표 겸업 등 수상 이력이 긴 문서).
 * 60은 그 위의 여유값이며, 경계는 아래 구조 규칙이 정하고 이 값은 폭주 방지용 상한일 뿐이다.
 */
const CATEGORY_LISTED_MAX_LINES = 60;

/**
 * ⚠️ **본문 마커** — 분류 라벨에는 절대 나타나지 않는 구조 요소.
 *
 * inline 레이아웃은 라벨 사이에 구분자가 없어서(`분류김도영대한민국의…`) 어디까지가 분류인지
 * 문자열만으로는 알 수 없다. 그래서 **분류 줄이 통째로 본문을 삼킨 상태인지**를 마커로 판정한다.
 * 삼켰다면 그 줄에서 읽은 `야구 선수`는 분류 신호가 아니라 본문 링크일 수 있으므로 **판정하지 않는다**
 * (삼순 NO-GO ② — 평탄화 문서 fail-open 축).
 *
 * 실측: inline 219건 중 이 마커가 분류 줄에 있는 문서는 **0건**이다. 즉 정상 문서는 걸리지 않고,
 * 평탄화가 더 진행된 문서만 `unparseable`로 fail-close 된다.
 */
const CATEGORY_BODY_MARKERS = ["[편집]", "문서를 참고하십시오", "여기로 연결됩니다", "자세한 내용은"];

function hasBodyMarker(value: string): boolean {
  return CATEGORY_BODY_MARKERS.some((marker) => value.includes(marker));
}

/** TOC 번호(`1`, `2.1`, `5.` …). listed 라벨 블록의 실측 종결자 중 하나. */
function isTableOfContentsNumber(line: string): boolean {
  return /^\d+(\.\d+)*\.?$/.test(line);
}

/**
 * listed 레이아웃에서 한 줄이 **분류 라벨 모양**인가.
 *
 * 라벨은 짧은 명사구다(`1989년 출생`, `kt wiz/현역`, `2009 FIFA U-17 월드컵 나이지리아 참가 선수`).
 * 반대로 라벨 블록 다음에 오는 것은 구조가 다르다(실측 종결자):
 *   - TOC 번호(`1`, `2.1`)
 *   - 참조 헤더(`동명이인에 대한 내용은` / `…2026 시즌에 대한 내용은`) → 항상 `내용은`으로 끝난다
 *   - 문장(`편집 보호된 문서입니다. 문서의`) → 마침표를 포함한다
 *   - 목록 항목(`빅터 레이예스 - 現 롯데 자이언츠 소속 야구 선수`) → ` - ` 구분자를 쓴다
 *   - 표/펼치기 마커(`[ 펼치기 · 접기 ]`, `· 45`)
 *
 * ⚠️ 라벨이 숫자로 시작하는 경우가 많다(`1989년 출생`). 그래서 "숫자로 시작하면 종료"는 쓸 수 없다
 *   — 실제로 그 규칙을 먼저 써봤다가 생년 라벨을 통째로 잃었다.
 */
export function isCorpusCategoryLabelLine(raw: string): boolean {
  const line = raw.trim();
  if (line.length === 0) return false;
  // 실측 라벨 최대 길이는 33자(`2011 FIFA U-20 월드컵 콜롬비아 참가 선수`). 40은 그 위 여유값이다.
  if (line.length > 40) return false;
  if (isTableOfContentsNumber(line)) return false;
  if (/^[.·\[(]/.test(line)) return false;
  if (line.endsWith("내용은")) return false;
  if (line.endsWith(".") || line.includes(". ")) return false;
  if (line.includes(" - ")) return false;
  return true;
}

/**
 * 분류 라벨 추출 — inline·listed 두 레이아웃 모두.
 *
 * 반환하는 `labels`는 **개별 라벨의 배열이 아니라 판정용 문자열 집합**이다.
 * inline은 구분자가 없어 라벨 단위로 쪼갤 수 없으므로 한 덩어리로 온다.
 */
export function extractCorpusCategoryLabels(text: string): {
  layout: CorpusCategoryLayout;
  labels: string[];
} {
  const lines = text.split("\n");
  const headLimit = Math.min(lines.length, CATEGORY_HEAD_LINES);
  let markerIndex = -1;
  for (let index = 0; index < headLimit; index += 1) {
    if (lines[index].startsWith("분류")) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex < 0) return { layout: "absent", labels: [] };

  const markerLine = lines[markerIndex];
  if (markerLine.trim() !== "분류") {
    // inline: `분류` 뒤가 같은 줄에서 이어진다.
    const inline = markerLine.slice(markerLine.indexOf("분류") + 2).trim();
    if (inline.length === 0) return { layout: "absent", labels: [] };
    // 본문을 삼킨 줄은 분류로 읽지 않는다(fail-close).
    if (hasBodyMarker(inline)) return { layout: "unparseable", labels: [] };
    return { layout: "inline", labels: [inline] };
  }

  // listed: 다음 줄부터 라벨이 한 줄씩 이어지고, 라벨 모양이 아닌 줄에서 끝난다.
  const labels: string[] = [];
  const stop = Math.min(lines.length, markerIndex + 1 + CATEGORY_LISTED_MAX_LINES);
  for (let index = markerIndex + 1; index < stop; index += 1) {
    if (!isCorpusCategoryLabelLine(lines[index])) break;
    labels.push(lines[index].trim());
  }
  if (labels.length === 0) return { layout: "absent", labels: [] };
  return { layout: "listed", labels };
}

/** 판정용 단일 문자열. 라벨 사이 경계는 개행으로 유지한다. */
export function joinCorpusCategoryLabels(labels: readonly string[]): string {
  return labels.join("\n");
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
 * 인포박스 `출생` 항목의 생년월일.
 *
 * ⚠️ **`출생` 라벨에 결속**한다 (삼순 NO-GO ① — 종전 코드는 앞 6,000자의 *첫 완전 날짜*를
 *   아무 맥락 없이 집어서, 등번호 이력·데뷔일·다른 선수 날짜를 생일로 오인할 수 있었다).
 *
 * 두 레이아웃 모두를 다룬다(실측):
 *   inline   `출생 \t 1984년 1월 18일[빠른생일][음력] (42세)`
 *   listed   `출생` `1989년` `12월 17일` `[2]` `(36세)`   ← 날짜가 여러 줄로 쪼개진다
 */
export function extractBirthClauseDate(
  text: string,
): { year: number; month: number; day: number } | undefined {
  const lines = text.split("\n");
  const clauseIndex = lines.findIndex((line) => line.trim() === "출생");
  if (clauseIndex < 0) return undefined;
  // 각주 마커(`[2]`, `[빠른생일]`)를 걷어내고 이어 붙인다. 날짜가 줄바꿈으로 쪼개져 있어도
  // `1989년` + `12월 17일` 이 하나의 날짜로 읽힌다.
  const clause = lines
    .slice(clauseIndex + 1, clauseIndex + 6)
    .map((line) => line.replace(/\[[^\]]*\]/g, "").trim())
    .join("");
  const matched = /((?:19|20)\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(clause);
  if (!matched) return undefined;
  return { year: Number(matched[1]), month: Number(matched[2]), day: Number(matched[3]) };
}

/** `1983-12-16` → `1983년 12월 16일`. 문서 표기와 대조하기 위한 정규화. */
export function formatRosterBirthDateForDocument(rosterBirthDate: string): string | undefined {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rosterBirthDate);
  if (!parsed) return undefined;
  return `${Number(parsed[1])}년 ${Number(parsed[2])}월 ${Number(parsed[3])}일`;
}

/**
 * **로스터 등록일이 문서 안에 직접 적혀 있는가.**
 *
 * ⚠️ 왜 이 형태인가 (삼순 NO-GO ① 반영). 종전 구현은 `연도 ±1 · 12/1월 · 60일 이내`라는
 *   **일반 근접일 휴리스틱**이었다. 그건 근거가 아니라 우연의 허용치라서, 같은 이름의 다른
 *   야구선수가 해 경계 60일 안에 태어나면 제목·분류까지 같아 그대로 오귀속된다.
 *
 * 그래서 근접이 아니라 **관계**를 본다: 문서가 스스로 "이 사람의 등록 생일은 X"라고 적어야 한다.
 * 실측(선수 문서 원문):
 *   최형우  로스터 1983-12-16 → 문서 각주 `[음력] 1983년 12월 16일`            ✅ 적혀 있음
 *   장성우  로스터 1990-01-17 → 문서 각주 `출생 신고를 한 달 늦게 해서 주민등록상 1990년 1월 17일생` ✅
 *   김태혁  로스터 1988-01-02 → 문서에 이 날짜가 **없다**(본문은 `실제 생일은 87년 12월`뿐) ❌
 *
 * 김태혁은 통과시키지 않는다. 근거가 문서에 없으면 격리가 정답이고, 세 명을 다 살리려고
 * 규칙을 늘리면 그게 바로 종전의 휴리스틱 회귀다.
 */
export function documentStatesRosterBirthDate(
  text: string,
  rosterBirthDate: string | undefined,
): boolean {
  if (!rosterBirthDate) return false;
  const needle = formatRosterBirthDateForDocument(rosterBirthDate);
  if (!needle) return false;
  return text.includes(needle);
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
  /** 로스터 생년월일 `YYYY-MM-DD`. 문서가 이 날짜를 직접 적고 있으면 생년 불일치를 설명한다. */
  rosterBirthDate?: string;
  seedName?: string;
  documentTitle?: string;
}): CorpusIdentityVerdict {
  const { layout, labels } = extractCorpusCategoryLabels(input.text);
  if (layout === "absent") {
    return { ok: false, status: "rejected", reason: "category_absent" };
  }
  if (layout === "unparseable") {
    // 분류 줄이 본문을 삼켰다. 여기서 읽는 `야구 선수`는 분류 신호가 아니다 — 판정하지 않는다.
    return { ok: false, status: "ambiguous", reason: "category_unparseable" };
  }
  const categories = joinCorpusCategoryLabels(labels);
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
  let birthEvidence: BirthEvidence = "category_year_match";
  if (!birthMatch) {
    // 분류 생년이 어긋난다. 문서가 로스터 등록일을 **직접 적고 있을 때만** 동일인으로 본다.
    if (!documentStatesRosterBirthDate(input.text, input.rosterBirthDate)) {
      return { ok: false, status: "rejected", reason: "birth_year_mismatch" };
    }
    // 문서 인포박스 생일과 로스터 생일이 서로 다른 기준(음력·출생신고 지연)이라는 뜻이다.
    // 인포박스 날짜 자체가 없으면 그 관계를 확인할 수 없으므로 통과시키지 않는다.
    if (!extractBirthClauseDate(input.text)) {
      return { ok: false, status: "ambiguous", reason: "birth_clause_absent" };
    }
    birthEvidence = "roster_date_stated_in_document";
  }

  // 제목 대조. 생년으로 걸러지지 않는 타인 문서 오귀속을 막는 마지막 방어선이다.
  if (!input.seedName || !input.documentTitle) {
    return { ok: false, status: "ambiguous", reason: "document_title_absent" };
  }
  const matchedTitle = titleMatchesSeed(input.seedName, input.documentTitle);
  if (!matchedTitle) {
    // 다른 선수 문서일 수 있다. 추측해서 귀속하지 않고 격리한다.
    return { ok: false, status: "ambiguous", reason: "document_title_mismatch" };
  }
  return { ok: true, matchedBirthYear: birthMatch === true, matchedTitle, birthEvidence };
}
