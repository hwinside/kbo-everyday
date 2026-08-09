/**
 * A17 corpus 신원 게이트 회귀.
 *
 * ⚠️ **모든 문서는 실 corpus 원문 발췌다.** `scripts/qa/fixtures/corpus-identity-documents.json` 은
 *   `scripts/qa/build-corpus-identity-fixtures.ts` 가 실 corpus(`namu-corpus-complete.jsonl`)에서
 *   기계적으로 뽑고, **발췌본과 원문의 판정이 동일할 때만** 채택한다.
 *
 *   왜 이렇게까지 하는가: 직전 판의 fixture는 손으로 지어낸 문자열이었고, 그래서 실 corpus의
 *   **listed 레이아웃(411/631건, 65%)을 통째로 못 봤다.** 지어낸 fixture는 "실측"이 아니다.
 *
 * ── 이 게이트가 지키는 계약 ────────────────────────────────────────────────
 *   1. 두 레이아웃(inline·listed)의 분류를 모두 읽는다.
 *   2. 분류 줄이 본문을 삼킨 문서는 판정하지 않는다(fail-close).
 *   3. 생년 불일치는 **문서가 로스터 등록일을 직접 적을 때만** 구제한다(근접일 휴리스틱 금지).
 *   4. 생년 불일치 실 corpus 전건 9명의 판정을 그대로 고정한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  documentStatesRosterBirthDate,
  extractBirthClauseDate,
  extractCorpusCategoryLabels,
  formatRosterBirthDateForDocument,
  hasBaseballPlayerCategory,
  isAmbiguityDocument,
  isCorpusCategoryLabelLine,
  joinCorpusCategoryLabels,
  matchesBirthYear,
  normalizeCorpusTitle,
  titleMatchesSeed,
  verifyCorpusPlayerIdentity,
  type CorpusIdentityVerdict,
} from "../../src/lib/baseball-qa/rag/corpus-identity";

type FixtureDocument = {
  entity: string;
  why: string;
  kboId?: string;
  rosterBirthDate?: string;
  title: string;
  canonical: string;
  fetchedAt: string;
  sourceLength: number;
  text: string;
};

const fixturePath = path.join(process.cwd(), "scripts/qa/fixtures/corpus-identity-documents.json");
const fixtures: { documents: FixtureDocument[] } = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const byEntity = new Map(fixtures.documents.map((document) => [document.entity, document]));

function document(entity: string): FixtureDocument {
  const found = byEntity.get(entity);
  if (!found) throw new Error(`fixture 없음: ${entity} (build-corpus-identity-fixtures 로 재생성)`);
  return found;
}

/** fixture 문서를 로스터 값 그대로 태운다 — 실제 로더 호출부와 같은 인자 조합. */
function verifyFixture(entity: string, override?: Partial<Parameters<typeof verifyCorpusPlayerIdentity>[0]>): CorpusIdentityVerdict {
  const fixture = document(entity);
  return verifyCorpusPlayerIdentity({
    text: fixture.text,
    rosterBirthYear: fixture.rosterBirthDate?.slice(0, 4),
    rosterBirthDate: fixture.rosterBirthDate,
    seedName: fixture.entity,
    documentTitle: fixture.title,
    ...override,
  });
}

let passed = 0;
const ok = (label: string): void => {
  passed += 1;
  console.log(`PASS ${label}`);
};

function assertRejected(verdict: CorpusIdentityVerdict, status: "ambiguous" | "rejected", reason: string, label: string): void {
  assert.equal(verdict.ok, false, `${label}: 통과하면 안 된다`);
  if (verdict.ok) return;
  assert.equal(verdict.status, status, `${label}: status`);
  assert.equal(verdict.reason, reason, `${label}: reason`);
}

/**
 * (1) **두 레이아웃 실측 고정** — 이 게이트가 놓치고 있던 축.
 *
 * 종전 코드는 `분류([^\n]*)` 하나로만 읽어 listed 문서의 캡처가 빈 문자열이 됐고,
 * 실 corpus 선수 루트 631건 중 **411건(65%)을 `category_absent` 로 버렸다.**
 */
function verifyBothLayouts(): void {
  const inline = extractCorpusCategoryLabels(document("김도영").text);
  assert.equal(inline.layout, "inline", "김도영은 inline 레이아웃이다");
  assert.ok(
    joinCorpusCategoryLabels(inline.labels).includes("2003년 출생"),
    "inline 분류에서 생년 라벨을 읽지 못했다",
  );

  const listed = extractCorpusCategoryLabels(document("강준서").text);
  assert.equal(listed.layout, "listed", "강준서는 listed 레이아웃이다 — 한 줄 파서로는 못 읽는다");
  assert.ok(listed.labels.length >= 8, `listed 라벨 블록이 ${listed.labels.length}개에서 조기 종료됐다`);
  assert.ok(
    listed.labels.includes("2000년 출생"),
    `listed 분류에서 생년 라벨을 읽지 못했다: ${JSON.stringify(listed.labels)}`,
  );
  assert.ok(
    listed.labels.some((label) => label.includes("야구 선수")),
    "listed 분류에서 야구선수 라벨을 읽지 못했다",
  );

  // listed 문서의 라벨 블록은 **참조 헤더/TOC에서 끝나야** 한다. 본문을 계속 먹으면
  // 아래 김진수(축구선수) 같은 문서가 본문 링크로 fail-open 한다.
  const kimhg = extractCorpusCategoryLabels(document("김헌곤").text);
  assert.equal(kimhg.layout, "listed");
  assert.equal(
    kimhg.labels[kimhg.labels.length - 1], "곤장님",
    `라벨 블록이 본문까지 먹었다: ${JSON.stringify(kimhg.labels.slice(-4))}`,
  );

  assert.equal(verifyFixture("김도영").ok, true, "inline 정상 문서가 거부됐다");
  assert.equal(verifyFixture("강준서").ok, true, "listed 정상 문서가 거부됐다");
  assert.equal(verifyFixture("김헌곤").ok, true, "listed 정상 문서가 거부됐다");
  ok("레이아웃 2종 실측 — inline·listed 분류를 모두 읽는다");
}

/**
 * (2) **분류 상한 없음** — `양의지` 분류는 428자다.
 * 종전 300자 상한은 `대한민국의 남자 야구 선수` 를 잘라내 본인 문서를 거부했다.
 * 훈장·수상이 많은 베테랑일수록 분류가 길어져 유명 선수부터 버려졌다.
 */
function verifyLongCategoryBlock(): void {
  const labels = extractCorpusCategoryLabels(document("양의지").text);
  const joined = joinCorpusCategoryLabels(labels.labels);
  assert.ok(joined.length > 300, `분류가 ${joined.length}자로 잘렸다 — 스캔 상한이 되살아났다`);
  // 양의지 분류에서 `야구 선수` 는 **맨 끝**(`인터넷 밈/야구 선수/대한민국`)에 있다.
  // 300자에서 자르면 정확히 이 신호가 사라져 본인 문서가 거부된다.
  assert.equal(hasBaseballPlayerCategory(joined), true, "300자 밖의 야구선수 분류를 못 본다");
  assert.equal(verifyFixture("양의지").ok, true, "양의지 본인 문서가 거부됐다 — 긴 분류가 잘렸다");
  ok("긴 분류 블록 — 상한 없이 끝까지 읽는다(양의지 428자)");
}

/**
 * (3) **평탄화 fail-open 방어** (삼순 NO-GO ②).
 *
 * inline 레이아웃은 구분자가 없어 어디까지가 분류인지 문자열만으론 모른다. 그래서 분류 줄이
 * 본문 마커를 포함하면(= 본문을 삼킨 상태) **판정하지 않는다.** 그 줄에서 읽은 `야구 선수` 는
 * 분류 신호가 아니라 본문 링크일 수 있기 때문이다.
 */
function verifyFlattenedFailClose(): void {
  const 레이예스 = document("레이예스");
  // 이 문서는 성씨 문서이고 **본문 후반에 야구선수 링크가 다수** 있다.
  assert.ok(
    레이예스.text.includes("야구 선수"),
    "fixture 전제 붕괴: 레이예스 본문에 야구선수 링크가 있어야 이 축이 성립한다",
  );
  assertRejected(verifyFixture("레이예스"), "rejected", "not_baseball_player_document",
    "성씨 문서가 본문 야구선수 링크로 통과했다");

  // 분류 줄이 본문까지 평탄화된 문서: 분류로 읽지 않고 격리한다.
  const 레이예스labels = extractCorpusCategoryLabels(레이예스.text);
  const flattened = 레이예스.text.replace(
    joinCorpusCategoryLabels(레이예스labels.labels),
    `${joinCorpusCategoryLabels(레이예스labels.labels)}빅터 레이예스 - 現 롯데 자이언츠 소속 야구 선수[편집]`,
  );
  const verdict = verifyCorpusPlayerIdentity({
    text: flattened, rosterBirthYear: "1994", rosterBirthDate: "1994-10-05",
    seedName: "레이예스", documentTitle: "레예스 - 나무위키",
  });
  assertRejected(verdict, "ambiguous", "category_unparseable",
    "분류 줄이 본문을 삼켰는데 판정했다 — 본문 링크가 분류 신호가 된다");

  assert.equal(extractCorpusCategoryLabels("분류대한민국의 남자 야구 선수[편집]").layout, "unparseable");
  assert.equal(extractCorpusCategoryLabels("분류대한민국의 남자 야구 선수").layout, "inline");
  ok("평탄화 fail-close — 본문 삼킨 분류 줄은 판정하지 않는다");
}

/**
 * (4) **동음이의 문서** — 판정 순서 계약.
 * 동음이의 문서에도 야구 항목이 섞여 있어(`강백호`) 야구분류를 먼저 보면 통과해버린다.
 */
function verifyAmbiguityDocuments(): void {
  // ⚠️ 강백호를 **먼저** 본다. 이 문서만 분류에 `동음이의`와 `야구선수`가 함께 있어
  //   판정 순서 계약을 직접 검증한다(오스틴은 야구 분류가 없어 순서와 무관하게 걸린다).
  assert.ok(
    document("강백호").text.includes("야구선수") || document("강백호").text.includes("야구 선수"),
    "fixture 전제 붕괴: 강백호 문서에 야구선수 문자열이 있어야 판정 순서 축이 성립한다",
  );
  assertRejected(verifyFixture("강백호"), "ambiguous", "ambiguity_document",
    "동음이의 문서에 야구선수가 섞여 있는데 통과했다");
  assertRejected(verifyFixture("오스틴"), "ambiguous", "ambiguity_document", "inline 동음이의");
  assertRejected(verifyFixture("박상원"), "ambiguous", "ambiguity_document", "listed 동음이의");
  assertRejected(verifyFixture("김진수"), "rejected", "not_baseball_player_document",
    "listed 축구선수 문서");
  ok("동음이의·타종목 문서 — 판정 순서로 차단");
}

/**
 * (5) **생년 불일치 전건 9명** (삼순 NO-GO ③ — 실 corpus 전수, 2026-08-09).
 *
 * 실 corpus 선수 루트 631건을 전건 재판정해 분류 생년이 로스터와 어긋난 9명을 뽑았다.
 * **전원의 판정을 여기에 고정한다** — 표본이 아니라 전건이다.
 *
 * 구제 근거는 근접일이 아니라 **문서가 로스터 등록일을 직접 적었는가**이다.
 * 김태혁은 본인 문서가 맞지만 등록일(1988-01-02)이 문서에 없어 격리한다. 세 명을 다 살리려고
 * 규칙을 늘리면 그게 종전 휴리스틱 회귀다.
 */
function verifyBirthMismatchCensus(): void {
  const census: Readonly<Record<string, { evidence: "stated" | "absent"; reason?: string }>> = {
    "최형우": { evidence: "stated" },   // 문서 각주 `[음력] 1983년 12월 16일`
    "장성우": { evidence: "stated" },   // 문서 각주 `주민등록상 1990년 1월 17일생`
    "김태혁": { evidence: "absent", reason: "birth_year_mismatch" },
    "박찬호": { evidence: "absent", reason: "birth_year_mismatch" },
    "이진영": { evidence: "absent", reason: "birth_year_mismatch" },
    "이호준": { evidence: "absent", reason: "birth_year_mismatch" },
    "최윤석": { evidence: "absent", reason: "birth_year_mismatch" },
    "권현규": { evidence: "absent", reason: "birth_year_mismatch" },
    "김민범": { evidence: "absent", reason: "birth_year_mismatch" },
  };
  for (const [entity, expectation] of Object.entries(census)) {
    const fixture = document(entity);
    // 전제: 이 9명은 전부 분류 생년이 로스터와 어긋난 문서다.
    const labels = extractCorpusCategoryLabels(fixture.text);
    assert.equal(
      matchesBirthYear(joinCorpusCategoryLabels(labels.labels), fixture.rosterBirthDate?.slice(0, 4)),
      false,
      `${entity}: fixture 전제 붕괴 — 분류 생년이 로스터와 일치한다`,
    );
    const stated = documentStatesRosterBirthDate(fixture.text, fixture.rosterBirthDate);
    assert.equal(stated, expectation.evidence === "stated", `${entity}: 등록일 문서 명시 여부`);

    const verdict = verifyFixture(entity);
    if (expectation.evidence === "stated") {
      assert.equal(verdict.ok, true, `${entity}: 본인 문서가 거부됐다 ${JSON.stringify(verdict)}`);
      if (verdict.ok) {
        assert.equal(verdict.matchedBirthYear, false);
        assert.equal(verdict.birthEvidence, "roster_date_stated_in_document", `${entity}: 구제 근거 라벨`);
      }
    } else {
      assertRejected(verdict, "rejected", expectation.reason!, `${entity}: 근거 없이 통과했다`);
    }
  }
  ok(`생년 불일치 전건 ${Object.keys(census).length}명 — 구제 2 / 격리·거부 7`);
}

/**
 * (6) **구제가 문을 열지 않는가** — 반대가설.
 * 근접일 휴리스틱이 되살아나면 여기서 걸린다.
 */
function verifyRescueDoesNotOpenDoor(): void {
  const 최형우 = document("최형우");
  // ⚠️ 순서가 계약이다. (a) 무근거 구제 → (b) 근접일 구제 순으로 본다.
  //   "구제 조건을 통째로 없앤" 결함과 "근접일 휴리스틱으로 되돌린" 결함은 서로 다른 실패이고,
  //   각각 고유한 assertion 에서 잡혀야 mutation 이 무엇을 증명했는지 말할 수 있다.

  // (a) 생년이 크게 어긋난 타인 문서 — 구제 조건 자체가 사라지면 여기서 걸린다.
  assertRejected(
    verifyFixture("김도영", { rosterBirthYear: "1990", rosterBirthDate: "1990-06-01" }),
    "rejected", "birth_year_mismatch",
    "생년이 13년 어긋난 문서가 통과했다 — 구제 조건이 사라졌다",
  );
  // (b) 등록일이 안 적힌 문서는 **아무리 가까워도** 구제되지 않는다.
  //     연도차 1 · 실제 1일 차이 — 근접일 휴리스틱이면 통과하고, 근거 요구면 거부한다.
  const stripped = 최형우.text.replace(/1983년 12월 16일/g, "1983년 12월 15일");
  assertRejected(
    verifyCorpusPlayerIdentity({
      text: stripped, rosterBirthYear: "1983", rosterBirthDate: "1983-12-16",
      seedName: "최형우", documentTitle: 최형우.title,
    }),
    "rejected", "birth_year_mismatch",
    "등록일이 1일 어긋났는데 통과했다 — 근접일 허용이 되살아났다",
  );
  // (c) 로스터 날짜가 없으면 구제하지 않는다.
  assertRejected(
    verifyFixture("최형우", { rosterBirthDate: undefined }),
    "rejected", "birth_year_mismatch",
    "로스터 날짜 없이 통과했다 — 없는 근거로 구제했다",
  );
  // (d) 출생 clause 자체가 없으면 관계를 확인할 수 없으므로 통과시키지 않는다.
  const noClause = 최형우.text.split("\n").filter((line) => line.trim() !== "출생").join("\n");
  assertRejected(
    verifyCorpusPlayerIdentity({
      text: noClause, rosterBirthYear: "1983", rosterBirthDate: "1983-12-16",
      seedName: "최형우", documentTitle: 최형우.title,
    }),
    "ambiguous", "birth_clause_absent",
    "인포박스 생일이 없는데 구제했다",
  );
  ok("구제 반대가설 4종 — 무근거·근접일·결측·clause부재 전부 거부");
}

/**
 * (7) **출생 clause 결속** (삼순 NO-GO ①).
 * 종전 코드는 앞 6,000자의 *첫 완전 날짜*를 맥락 없이 집었다. 등번호 이력·데뷔일·다른 선수
 * 날짜를 생일로 오인할 수 있다. 이제 `출생` 라벨 뒤만 읽는다.
 */
function verifyBirthClauseBinding(): void {
  // ⚠️ **결속 해제부터** 본다 — `출생` 라벨을 안 보고 아무 날짜나 집으면 여기서 걸린다.
  assert.equal(
    extractBirthClauseDate("분류김도영대한민국의 남자 야구 선수2003년 출생\n데뷔\n2022년 4월 1일"),
    undefined,
    "출생 clause가 없는데 데뷔일을 생일로 읽었다",
  );
  // inline: `출생 \t 1984년 1월 18일[빠른생일][음력] (42세)`
  assert.deepEqual(
    extractBirthClauseDate(document("최형우").text), { year: 1984, month: 1, day: 18 },
    "inline 출생 clause 를 읽지 못했다",
  );
  // listed: `출생` / `1989년` / `12월 17일` / `[2]` — 줄바꿈으로 쪼개진 날짜를 이어 읽는다.
  assert.deepEqual(
    extractBirthClauseDate(document("장성우").text), { year: 1989, month: 12, day: 17 },
    "listed 출생 clause 를 읽지 못했다 — 줄바꿈으로 쪼개진 날짜를 이어 읽어야 한다",
  );
  assert.deepEqual(
    extractBirthClauseDate(document("김도영").text), { year: 2003, month: 10, day: 2 },
    "inline 출생 clause 를 읽지 못했다",
  );
  assert.equal(formatRosterBirthDateForDocument("1983-12-16"), "1983년 12월 16일");
  assert.equal(formatRosterBirthDateForDocument("1983/12/16"), undefined);
  ok("출생 clause 결속 — inline·listed 양쪽 + 무관 날짜 차단");
}

/** (8) 분류 부재 / 라벨 모양 / 표기 정규화. */
function verifyStructuralHelpers(): void {
  const verdict = verifyCorpusPlayerIdentity({
    text: "제목만 있고 카테고리 표기가 없는 본문입니다.", rosterBirthYear: "2000",
  });
  assertRejected(verdict, "rejected", "category_absent", "분류 부재");
  assert.equal(extractCorpusCategoryLabels("").layout, "absent");

  assert.equal(isCorpusCategoryLabelLine("1989년 출생"), true, "숫자로 시작하는 라벨을 잘랐다");
  assert.equal(isCorpusCategoryLabelLine("kt wiz/현역"), true);
  assert.equal(isCorpusCategoryLabelLine("2.1"), false, "TOC 번호를 라벨로 읽었다");
  assert.equal(isCorpusCategoryLabelLine("동명이인에 대한 내용은"), false, "참조 헤더를 라벨로 읽었다");
  assert.equal(isCorpusCategoryLabelLine("편집 보호된 문서입니다. 문서의"), false, "문장을 라벨로 읽었다");
  assert.equal(isCorpusCategoryLabelLine("빅터 레이예스 - 現 롯데 자이언츠 소속 야구 선수"), false, "목록 항목을 라벨로 읽었다");
  assert.equal(isCorpusCategoryLabelLine("[ 펼치기 · 접기 ]"), false);

  assert.equal(hasBaseballPlayerCategory("대한민국의 남자 야구 선수"), true);
  assert.equal(hasBaseballPlayerCategory("야구선수"), true);
  assert.equal(hasBaseballPlayerCategory("성씨/영미권"), false);
  assert.equal(isAmbiguityDocument("동음이의어성씨"), true);
  assert.equal(isAmbiguityDocument("동명이인"), true);
  assert.equal(isAmbiguityDocument("대한민국의 남자 야구 선수"), false);
  assert.equal(matchesBirthYear("분류성씨/영미권", "2003"), null, "출생 분류가 없으면 판정하지 않는다");
  assert.equal(matchesBirthYear("2003년 출생", undefined), null, "로스터 생년이 없으면 판정하지 않는다");
  ok("구조 헬퍼 — 라벨 경계·표기 정규화·판정 불가 fail-close");
}

/** (9) 제목 대조 — 분류·생년으로 안 걸러지는 타인 문서 오귀속 방어. */
function verifyTitleGate(): void {
  assert.equal(normalizeCorpusTitle("김도영 - 나무위키"), "김도영");
  assert.equal(titleMatchesSeed("김도영", "김도영 - 나무위키"), true);
  assert.equal(titleMatchesSeed("올러", "아담 올러 - 나무위키"), true);
  assert.equal(titleMatchesSeed("레이예스", "레예스 - 나무위키"), true);
  assert.equal(titleMatchesSeed("벤자민", "벤저민 - 나무위키"), true);
  assert.equal(titleMatchesSeed("김도영", "문보경 - 나무위키"), false);

  // 분류·생년이 모두 통과하는 다른 선수 문서 → 제목이 마지막 방어선이다.
  assertRejected(
    verifyFixture("김도영", { seedName: "문보경" }),
    "ambiguous", "document_title_mismatch",
    "다른 선수 문서에 도착했는데 통과했다",
  );
  assertRejected(
    verifyFixture("김도영", { documentTitle: undefined }),
    "ambiguous", "document_title_absent",
    "제목 정보가 없는데 귀속했다",
  );
  assertRejected(
    verifyFixture("김도영", { rosterBirthYear: undefined, rosterBirthDate: undefined }),
    "ambiguous", "roster_birth_year_absent",
    "로스터 생년이 없는데 귀속했다",
  );
  ok("제목 대조 — 타인 문서 격리 / 풀네임·표기차 허용");
}

/** (10) fixture 자체가 실 corpus 발췌인지 — 지어낸 문자열이 섞이면 여기서 막는다. */
function verifyFixtureProvenance(): void {
  assert.ok(fixtures.documents.length >= 18, `fixture 문서가 ${fixtures.documents.length}건뿐이다`);
  for (const fixture of fixtures.documents) {
    assert.ok(/^https:\/\/namu\.wiki\/w\/\S+$/.test(fixture.canonical), `${fixture.entity}: canonical`);
    assert.ok(Number.isFinite(Date.parse(fixture.fetchedAt)), `${fixture.entity}: fetchedAt`);
    assert.ok(fixture.text.length <= fixture.sourceLength + 400, `${fixture.entity}: 발췌가 원문보다 길다`);
    assert.equal(
      normalizeCorpusTitle(fixture.title),
      decodeURIComponent(new URL(fixture.canonical).pathname.slice(3)).replace(/_/g, " "),
      `${fixture.entity}: title↔canonical 불일치 — 실 corpus 레코드가 아니다`,
    );
    assert.ok(fixture.why.length > 0, `${fixture.entity}: 선정 근거가 없다`);
  }
  ok(`fixture 출처 — 실 corpus 발췌 ${fixtures.documents.length}건`);
}

function run(): void {
  verifyFixtureProvenance();
  verifyBothLayouts();
  verifyLongCategoryBlock();
  verifyFlattenedFailClose();
  verifyAmbiguityDocuments();
  // ⚠️ 실행 순서가 mutation 특정성의 일부다. clause 결속 → 구제 반대가설 → 전건 census 순으로
  //   좁은 계약부터 본다. 반대로 두면 census 의 포괄 assertion 이 먼저 깨져서 어떤 결함인지
  //   구분되지 않는다(실측: 6개 변이가 같은 문구로 뭉쳤다).
  verifyBirthClauseBinding();
  verifyRescueDoesNotOpenDoor();
  verifyBirthMismatchCensus();
  verifyStructuralHelpers();
  verifyTitleGate();
  console.log(`\nbaseball QA corpus identity PASS (${passed} 섹션)`);
}

run();
