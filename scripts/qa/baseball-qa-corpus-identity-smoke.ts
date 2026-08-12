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
import { createHash } from "node:crypto";
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
import {
  canonicalIdentityTuple,
  computeRosterIdentityFingerprint,
  fingerprintOfTuples,
  fingerprintRosterFile,
  rosterIdentityTuples,
  type RosterIdentitySource,
} from "./roster-identity-fingerprint";
import { classifyIdentityDrift, multisetSymmetricDiff, tupleName } from "./roster-identity-impact";

type FixtureDocument = {
  entity: string;
  why: string;
  kboId?: string;
  rosterBirthDate?: string;
  title: string;
  canonical: string;
  fetchedAt: string;
  sourceLength: number;
  sourceSha256: string;
  text: string;
};

type FixtureFile = {
  corpusFile: string;
  corpusSha256: string;
  corpusPhysicalLines: number;
  documents: FixtureDocument[];
};

type CensusFile = {
  corpusFile: string;
  corpusSha256: string;
  corpusPhysicalLines: number;
  /** 신원 multiset(name·kboId·birthDate) 지문 — 게이트가 비교하는 값. */
  rosterIdentitySha256: string;
  /** 기준 신원 multiset 원문 — 지문 drift 시 corpus 없는 CI 영향 판정의 입력. */
  rosterIdentityTuples: string[];
  /** census 빌드 시점 로스터 파일 해시 — provenance 참고용. 게이트 비교 대상이 아니다. */
  rosterFileSha256AtBuild: string;
  /** PR base(merge-base) 커밋. 이 PR 안의 중간 커밋이 아니다. */
  baseCommit: string;
  baseIdentitySha256: string;
  currentIdentitySha256: string;
  playerRootDocuments: number;
  baseAssigned: number;
  currentAssigned: number;
  transitions: Record<string, number>;
  /** 선택: 이 PR 안의 직전 exact 와의 비교. base 비교와 섞이면 안 된다. */
  previousCommit?: string;
  previousIdentitySha256?: string;
  previousAssigned?: number;
  previousTransitions?: Record<string, number>;
  rows: {
    entity: string;
    kboId: string | null;
    documentSha256: string;
    base: string;
    current: string;
    transition: string;
    previous?: string;
    previousTransition?: string;
  }[];
};

const fixturePath = path.join(process.cwd(), "scripts/qa/fixtures/corpus-identity-documents.json");
const censusPath = path.join(process.cwd(), "scripts/qa/fixtures/corpus-identity-census.json");
const fixtures: FixtureFile = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const census: CensusFile = JSON.parse(fs.readFileSync(censusPath, "utf8"));
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
 * (6b) **등록일이 무관한 본문에 있는 경우** (삼순 NO-GO 2차 ①).
 *
 * 직전 구현은 `text.includes(등록일)` 이었다. 선수 문서엔 날짜가 수십 개다(경기일·이적일·
 * 다른 선수 생일). 타인 문서가 우연히 그 날짜를 포함하면 그대로 통과했다.
 *
 * 아래 문서는 **실 corpus 원문에서 파생**시켰다 — 김태혁 문서(로스터 1988-01-02 가 원문에
 * 없는 실측 케이스)의 본문 서술 줄에 그 날짜를 넣은 것이다. 등록 관계 신호가 없으므로
 * 여전히 거부되어야 한다. 반대로 같은 자리에 관계 신호를 달아주면 통과해야 한다(과차단 없음).
 */
function verifyBirthDateRelationBinding(): void {
  const 김태혁 = document("김태혁");
  const rosterBirthDate = 김태혁.rosterBirthDate!;
  const needle = formatRosterBirthDateForDocument(rosterBirthDate)!;
  assert.equal(
    김태혁.text.includes(needle), false,
    "fixture 전제 붕괴: 김태혁 원문에 로스터 등록일이 없어야 이 축이 성립한다",
  );

  // ⚠️ 문서 어딘가에 관계 신호가 있고(`음력`), 등록일은 **그곳과 멀리 떨어진** 서술에 있다.
  //   이렇게 둘을 떨어뜨려야 "관계 신호 구간"과 "문서 전체"를 구분한다 — 구간을 문서 전체로
  //   넓히는 변이가 정확히 이 사이를 빠져나가기 때문이다(실측: 무작위 간격이면 그 변이가 GREEN 이었다).
  // (a) 무관한 본문 서술에 등록일만 들어있는 경우 — 근거가 아니다.
  const unrelated = [
    "[음력] 이 문서에는 음력 표기 설명이 따로 있다.",
    김태혁.text,
    `이날 경기는 ${needle}에 열렸다.`,
  ].join("\n");
  assert.ok(unrelated.includes(needle), "fixture 전제 붕괴: 등록일이 본문에 들어가야 한다");
  assert.ok(unrelated.includes("음력"), "fixture 전제 붕괴: 관계 신호가 문서 어딘가에 있어야 한다");
  {
    const lines = unrelated.split("\n");
    const signalLine = lines.findIndex((line) => line.includes("음력"));
    const dateLine = lines.findIndex((line) => line.includes(needle));
    assert.ok(
      Math.abs(signalLine - dateLine) > 2,
      "fixture 전제 붕괴: 관계 신호와 날짜가 같은 구간에 있으면 이 축이 성립하지 않는다",
    );
  }
  assert.equal(
    documentStatesRosterBirthDate(unrelated, rosterBirthDate), false,
    "무관한 본문의 같은 날짜를 등록 근거로 읽었다 — 관계 결속이 사라졌다",
  );
  assertRejected(
    verifyCorpusPlayerIdentity({
      text: unrelated,
      rosterBirthYear: rosterBirthDate.slice(0, 4), rosterBirthDate,
      seedName: 김태혁.entity, documentTitle: 김태혁.title,
    }),
    "rejected", "birth_year_mismatch",
    "무관한 본문의 날짜로 생년 불일치 문서가 통과했다",
  );

  // (b) 같은 자리에 **등록 관계 신호**가 붙으면 근거로 인정한다 — 과차단이 아니라는 증명.
  const related = `${김태혁.text}\n[음력] ${needle}`;
  assert.equal(
    documentStatesRosterBirthDate(related, rosterBirthDate), true,
    "등록 관계 신호(음력)가 붙은 날짜를 근거로 안 잎었다 — 과차단이다",
  );
  const rescued = verifyCorpusPlayerIdentity({
    text: related,
    rosterBirthYear: rosterBirthDate.slice(0, 4), rosterBirthDate,
    seedName: 김태혁.entity, documentTitle: 김태혁.title,
  });
  assert.equal(rescued.ok, true, `관계 신호가 있는데 거부됐다: ${JSON.stringify(rescued)}`);
  if (rescued.ok) assert.equal(rescued.birthEvidence, "roster_date_stated_in_document");

  // (c) 구제된 2명은 관계 신호가 실제로 같은 구간에 있다(실 원문).
  for (const [entity, signal] of [["최형우", "음력"], ["장성우", "주민등록"]] as const) {
    const fixture = document(entity);
    const target = formatRosterBirthDateForDocument(fixture.rosterBirthDate!)!;
    const line = fixture.text.split("\n").find((value) => value.includes(target));
    assert.ok(line, `${entity}: 등록일 줄을 찾지 못했다`);
    assert.ok(line!.includes(signal), `${entity}: 관계 신호 '${signal}' 가 같은 줄에 없다`);
  }
  ok("등록일 관계 결속 — 무관 본문 거부 / 관계 신호 인정 / 실원문 구간 확인");
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

/**
 * (10) **artifact 출처 결속** (삼순 NO-GO 2차 ②).
 *
 * fixture 와 census 가 **같은 corpus** 에서 나왔음을 해시로 증명한다. 둘 중 하나만 재생성하면
 * 해시가 갈라져 여기서 RED 가 된다 — "어느 corpus 기준인지 모르게 되는" 상태를 차단한다.
 * 문서별로도 원문 SHA-256 을 대조해 발췌본이 다른 판의 문서에서 왔는지 확인한다.
 */
function verifyFixtureProvenance(): void {
  assert.ok(fixtures.documents.length >= 18, `fixture 문서가 ${fixtures.documents.length}건뿐이다`);
  assert.equal(
    fixtures.corpusSha256, census.corpusSha256,
    "fixture 와 census 의 corpus 해시가 다르다 — 두 artifact 가 같은 입력에서 나오지 않았다",
  );
  assert.equal(fixtures.corpusPhysicalLines, census.corpusPhysicalLines, "corpus 물리 행 수 불일치");
  assert.equal(fixtures.corpusFile, census.corpusFile, "corpus 파일명 불일치");
  assert.ok(/^[0-9a-f]{64}$/.test(census.corpusSha256), "corpus SHA-256 형식");
  const censusByEntity = new Map(census.rows.map((row) => [row.entity, row]));
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
    const row = censusByEntity.get(fixture.entity);
    assert.ok(row, `${fixture.entity}: census 에 없는 문서다`);
    assert.equal(
      fixture.sourceSha256, row!.documentSha256,
      `${fixture.entity}: 원문 해시가 census 와 다르다 — 다른 판의 문서를 발췌했다`,
    );
  }
  ok(`fixture 출처 — 실 corpus 발췌 ${fixtures.documents.length}건 · census 해시 일치`);
}

/**
 * (11) **census before/after 정합성** (삼순 NO-GO 2차 ②).
 *
 * `156 → 395` 를 재현 가능하게 고정한다. 합계가 행별 판정과 맞는지, 전이 분류가 base/current
 * 조합으로 설명되는지까지 검사한다. artifact 를 손으로 고치면 여기서 깨진다.
 *
 * ⚠️ `lost` 는 0 이어야 한다 — 이 PR 은 더 읽는 변경이지 더 막는 변경이 아니다.
 *   lost 가 생기면 기존에 서빙되던 문서가 빠진다는 뜻이므로 멈춰야 한다.
 */
function verifyCensusIntegrity(): void {
  assert.equal(census.rows.length, census.playerRootDocuments, "census 행 수와 선언된 문서 수가 다르다");
  // ⚠️ base 는 **PR base 커밋**이어야 한다 (삼순 NO-GO 3차).
  //   직전 판은 이 PR 안의 중간 커밋을 base 로 썼고, 그래서 숫자가 "main→현재" 가 아니라
  //   "중간 broken exact→현재" 였다. 커밋 SHA 를 artifact 에 박아 사후 확인이 가능하게 한다.
  assert.ok(
    /^[0-9a-f]{40}$/.test(census.baseCommit),
    `baseCommit 이 40자리 커밋 SHA 가 아니다: ${census.baseCommit}`,
  );
  assert.notEqual(
    census.baseIdentitySha256, census.currentIdentitySha256,
    "base·current 구현 해시가 같다 — before/after 대조가 성립하지 않는다",
  );
  // 중간 exact 비교는 **있어도 되지만 base 비교와 섞이면 안 된다.**
  if (census.previousCommit !== undefined || census.previousTransitions !== undefined) {
    assert.ok(
      /^[0-9a-f]{40}$/.test(census.previousCommit ?? ""),
      "previousCommit 이 40자리 커밋 SHA 가 아니다",
    );
    assert.notEqual(
      census.previousCommit, census.baseCommit,
      "previousCommit 과 baseCommit 이 같다 — 두 비교를 분리한 의미가 없다",
    );
    const previousAssigned = census.rows.filter((row) => (row.previous ?? "").startsWith("assigned")).length;
    assert.equal(previousAssigned, census.previousAssigned, "previousAssigned 가 행별 판정과 맞지 않는다");
    // previous 도 base 와 **동일한 강도**로 검사한다 — 한쪽만 검사하면 그쪽으로 오염이 샌다.
    const previousRecomputed: Record<string, number> = {};
    for (const row of census.rows) {
      assert.ok(row.previous !== undefined, `${row.entity}: previous 판정이 빠졌다`);
      const fromAssigned = row.previous!.startsWith("assigned");
      const toAssigned = row.current.startsWith("assigned");
      const transition = fromAssigned === toAssigned
        ? (fromAssigned ? "kept_assigned" : "kept_excluded")
        : (toAssigned ? "gained" : "lost");
      assert.equal(
        row.previousTransition, transition,
        `${row.entity}: previousTransition 라벨이 previous/current 와 안 맞는다`,
      );
      previousRecomputed[transition] = (previousRecomputed[transition] ?? 0) + 1;
    }
    assert.deepEqual(
      previousRecomputed, census.previousTransitions,
      "previousTransitions 집계가 행별 판정과 다르다",
    );
    assert.equal(
      (census.previousAssigned ?? 0) + (census.previousTransitions?.gained ?? 0)
        - (census.previousTransitions?.lost ?? 0),
      census.currentAssigned,
      "previous gained/lost 가 previous→current 차이를 설명하지 못한다",
    );
  }
  const countAssigned = (key: "base" | "current") =>
    census.rows.filter((row) => row[key].startsWith("assigned")).length;
  assert.equal(countAssigned("base"), census.baseAssigned, "baseAssigned 가 행별 판정과 맞지 않는다");
  assert.equal(countAssigned("current"), census.currentAssigned, "currentAssigned 가 행별 판정과 맞지 않는다");
  assert.ok(
    census.currentAssigned > census.baseAssigned,
    `이 PR 은 통과를 늘려야 한다: ${census.baseAssigned} → ${census.currentAssigned}`,
  );

  const recomputed: Record<string, number> = {};
  for (const row of census.rows) {
    const baseAssigned = row.base.startsWith("assigned");
    const currentAssigned = row.current.startsWith("assigned");
    const transition = baseAssigned === currentAssigned
      ? (baseAssigned ? "kept_assigned" : "kept_excluded")
      : (currentAssigned ? "gained" : "lost");
    assert.equal(row.transition, transition, `${row.entity}: transition 라벨이 base/current 와 안 맞는다`);
    recomputed[transition] = (recomputed[transition] ?? 0) + 1;
  }
  assert.deepEqual(recomputed, census.transitions, "transitions 집계가 행별 판정과 다르다");
  assert.equal(census.transitions.lost ?? 0, 0, "기존에 통과하던 문서가 떨어졌다(lost > 0)");
  assert.equal(
    census.baseAssigned + (census.transitions.gained ?? 0), census.currentAssigned,
    "gained 가 before→after 차이를 설명하지 못한다",
  );

  // 대표 전이 표본: listed 레이아웃 문서가 base 에서 `category_absent` 였다는 게 이 PR 의 핵심이다.
  const 강준서 = census.rows.find((row) => row.entity === "강준서");
  assert.ok(강준서, "census 에 강준서가 없다");
  assert.equal(강준서!.base, "rejected:category_absent", "listed 문서가 base 에서 분류 부재가 아니었다");
  assert.equal(강준서!.current, "assigned");
  // census 의 로스터 **신원 지문** 대조 — 3단 계약(완전 무인화, 2026-08-12):
  //   ① 기준 튜플 원문이 저장된 지문과 결속되는지 먼저 검증(원문 변조로 영향판정 우회 방어)
  //   ② 현재 로스터 지문이 일치하면 PASS
  //   ③ 불일치면 corpus 없이 판정 가능한 **영향 분류**로 갈린다(roster-identity-impact.ts):
  //      변경된 이름이 census entity 와 교집합 0 → 판정 불변이 증명되므로 PASS(무인 통과),
  //      교집합 있으면(동명이인 생성·corpus 대상 선수 신원 변경) T7 재생성 fail-close.
  const storedTuples = census.rosterIdentityTuples;
  assert.ok(Array.isArray(storedTuples) && storedTuples.length > 500,
    "census 에 기준 신원 multiset 원문(rosterIdentityTuples)이 없다 — census 를 재생성해야 한다");
  assert.equal(fingerprintOfTuples(storedTuples), census.rosterIdentitySha256,
    "census 의 기준 튜플 원문이 저장된 지문과 결속되지 않는다 — 원문 변조로 영향 판정을 우회할 수 있다");
  const currentTuples = rosterIdentityTuples(
    JSON.parse(fs.readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json"), "utf8")),
  );
  if (fingerprintOfTuples(currentTuples) !== census.rosterIdentitySha256) {
    const censusEntities = new Set(census.rows.map((row) => row.entity));
    const verdict = classifyIdentityDrift(storedTuples, currentTuples, censusEntities);
    assert.equal(
      verdict.affected, false,
      `신원 변경이 census 판정에 영향을 준다(${verdict.affected ? `${verdict.reason}: ${verdict.affectedNames.join(", ")}` : ""}) — T7 에서 census 를 재생성해야 한다`,
    );
    if (!verdict.affected) {
      console.log(`  ℹ️ 신원 지문 drift 수용 — 변경 이름 ${verdict.changedNames.length}명 전원 census 비영향(corpus 루트 부재): ${verdict.changedNames.slice(0, 8).join(", ")}${verdict.changedNames.length > 8 ? " …" : ""}`);
    }
  }
  ok(`census 정합성 — base(${census.baseCommit.slice(0, 9)}) ${census.baseAssigned}→${census.currentAssigned} · ${JSON.stringify(census.transitions)}`);
}

/**
 * (신원 지문) **canonical fingerprint 계약** — #1162 사고의 재발 방지 축.
 *
 * 수용조건(삼순 조건부 GO, 2026-08-12):
 *   PASS 측: stats/photo/team/position/backNo 갱신·JSON reorder·포맷 변경은 지문 불변.
 *   RED 측: 선수 add/remove · name/kboId/birthDate 변경 · 동일 튜플 multiplicity 변화는 지문 변경.
 * 양쪽을 다 고정해야 한다 — 한쪽만 보면 과소(신원 변경을 놓침) 또는 과대(매일 갱신이 다시 전건 FAIL)로 기운다.
 */
function verifyRosterFingerprintContract(): void {
  const rosterRaw = fs.readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json"), "utf8");
  const roster = JSON.parse(rosterRaw) as (RosterIdentitySource & Record<string, unknown>)[];
  assert.ok(roster.length > 500, `로스터가 비정상적으로 작다: ${roster.length}`);
  const baseline = computeRosterIdentityFingerprint(roster);

  // ─ PASS 측: 신원 무관 변경은 지문을 바꾸면 안 된다 ────────────────────────────
  const reordered = [...roster].reverse();
  assert.equal(computeRosterIdentityFingerprint(reordered), baseline,
    "JSON 순서 변경이 지문을 바꿨다 — multiset 이 아니라 순서에 묶였다");
  const nonIdentityTouched = roster.map((player) => ({
    ...player, team: "가상", teamId: 99, position: "지명타자", backNo: "999",
  }));
  assert.equal(computeRosterIdentityFingerprint(nonIdentityTouched), baseline,
    "team/position/backNo 변경이 지문을 바꿨다 — 지문이 과대해서 매일 갱신이 다시 전건 FAIL 로 돌아간다");
  assert.equal(fingerprintRosterFile(JSON.stringify(roster)), baseline,
    "JSON 포맷(들여쓰기·개행) 변경이 지문을 바꿨다 — canonical 직렬화가 아니다");

  // ─ RED 측: 신원 변경은 지문이 반드시 바뀌어야 한다(fail-close) ───────────────────
  const added = [...roster, { name: "가상신인", kboId: "99999", birthDate: "2004-01-01" }];
  assert.notEqual(computeRosterIdentityFingerprint(added), baseline,
    "선수 추가가 지문에 반영되지 않았다 — 명단 변경을 stale census 가 통과한다");
  assert.notEqual(computeRosterIdentityFingerprint(roster.slice(1)), baseline,
    "선수 제외가 지문에 반영되지 않았다");
  const nameChanged = roster.map((player, index) => (index === 0 ? { ...player, name: `${player.name}′` } : player));
  assert.notEqual(computeRosterIdentityFingerprint(nameChanged), baseline,
    "name 변경이 지문에 반영되지 않았다");
  const kboIdChanged = roster.map((player, index) => (index === 0 ? { ...player, kboId: "00000" } : player));
  assert.notEqual(computeRosterIdentityFingerprint(kboIdChanged), baseline,
    "kboId 변경이 지문에 반영되지 않았다");
  const birthChanged = roster.map((player, index) => (index === 0 ? { ...player, birthDate: "1900-01-01" } : player));
  assert.notEqual(computeRosterIdentityFingerprint(birthChanged), baseline,
    "birthDate 변경이 지문에 반영되지 않았다");
  // multiplicity: 같은 신원 튜플이 하나 더 생기면(동명이인 등록 등) 지문이 바뀌어야 한다.
  const duplicated = [...roster, { ...roster[0] }];
  assert.notEqual(computeRosterIdentityFingerprint(duplicated), baseline,
    "동일 튜플 multiplicity 변화가 지문에 반영되지 않았다 — 중복이 dedupe 됐다");

  // ─ raw exact 계약 (삼순 재리뷰 blocker 2026-08-12) ──────────────────────────────
  // census/loader 는 값을 trim 없이 그대로 쓴다(byName 키 = raw name). whitespace 변이는
  // loader 귀속을 바꾸므로 지문도 반드시 바뀌어야 한다(지문이 값을 가공하면 false-GREEN).
  const nameWs = roster.map((player, index) => (index === 0 ? { ...player, name: `${player.name} ` } : player));
  assert.notEqual(computeRosterIdentityFingerprint(nameWs), baseline,
    "name whitespace 변이가 지문에 반영되지 않았다 — 지문이 값을 가공(trim)하고 있다");
  const kboIdWs = roster.map((player, index) => (index === 0 ? { ...player, kboId: ` ${player.kboId}` } : player));
  assert.notEqual(computeRosterIdentityFingerprint(kboIdWs), baseline,
    "kboId whitespace 변이가 지문에 반영되지 않았다");
  const birthWs = roster.map((player, index) => (index === 0 ? { ...player, birthDate: `${player.birthDate}\t` } : player));
  assert.notEqual(computeRosterIdentityFingerprint(birthWs), baseline,
    "birthDate whitespace 변이가 지문에 반영되지 않았다");

  // ─ 무충돌 직렬화 계약 ──────────────────────────────────────────────────────────────────
  // 필드 경계 이동(같은 문자열을 필드를 다르게 쪼개기)·구분자 문자 주입이 같은 지문을
  // 만들면 안 된다. JSON 직렬화가 제어문자·구분자를 escape 하므로 충돌이 불가능해야 한다.
  assert.notEqual(
    computeRosterIdentityFingerprint([{ name: "a\u0000b", kboId: "c", birthDate: "d" }]),
    computeRosterIdentityFingerprint([{ name: "a", kboId: "b\u0000c", birthDate: "d" }]),
    "필드 경계 이동이 같은 지문을 만든다 — 구분자 충돌이 살아났다",
  );
  assert.notEqual(
    computeRosterIdentityFingerprint([
      { name: "a", kboId: "b", birthDate: "c" },
      { name: "d", kboId: "e", birthDate: "f" },
    ]),
    computeRosterIdentityFingerprint([{ name: "a", kboId: "b", birthDate: `c\n["d","e","f"]` }]),
    "필드에 주입한 개행+직렬화 모양 문자열이 행 경계를 위조한다 — 튜플 경계 충돌이 살아났다",
  );
  // ─ 타입 raw exact (삼순 2차 blocker) ────────────────────────────────────────────
  // validator 는 kboId 의 string/number 를 모두 허용하고 loader 는 원타입을 산출물에 넣는다.
  // 지문이 String() 강제변환을 하면 `"53006" → 53006` 타입 변화가 false-GREEN 된다.
  assert.notEqual(
    computeRosterIdentityFingerprint([{ name: "x", kboId: "53006", birthDate: "2000-01-01" }]),
    computeRosterIdentityFingerprint([{ name: "x", kboId: 53006, birthDate: "2000-01-01" }]),
    "kboId string↔number 타입 변화가 지문에 반영되지 않았다 — 지문이 값을 강제변환(String)하고 있다",
  );
  // 결측(null/undefined)은 JSON null 로 결정론적으로 표기된다 — 표현 불가능한 undefined 만 예외이고
  // 그 외 어떤 값도(타입 포함) 가공되지 않는다("" 와 null 은 서로 다른 지문).
  assert.equal(
    canonicalIdentityTuple({ name: "무생년", kboId: "1", birthDate: undefined }),
    canonicalIdentityTuple({ name: "무생년", kboId: "1", birthDate: null }),
    "결측 birthDate(null/undefined)의 canonical 표기가 결정론적이지 않다",
  );
  assert.notEqual(
    canonicalIdentityTuple({ name: "무생년", kboId: "1", birthDate: "" }),
    canonicalIdentityTuple({ name: "무생년", kboId: "1", birthDate: null }),
    '"" 와 null 이 같은 지문으로 뭉쳤다 — raw exact 가 아니다',
  );
  ok("신원 지문 계약 — 신원 무관 PASS 3종 · 신원 변경 RED 6종 · whitespace RED 3종 · 타입 RED 1종 · 충돌 방지 2종");
}

/**
 * (영향 판정) **완전 무인화 계약** — corpus 없는 CI 가 신원 drift 를 분류한다.
 * 양방향 고정: 비영향(신규/이탈 이름이 census entity 밖)은 PASS, 영향(동명이인 생성·
 * corpus 대상 선수 신원 변경·이탈·판정불가)은 fail-close. 한쪽만 보면 무인화 회귀(과대)
 * 또는 stale census 통과(과소)로 기운다. 입력은 실 census 에서 기계 추출한다.
 */
function verifyIdentityImpactContract(): void {
  const censusEntities = new Set(census.rows.map((row) => row.entity));
  assert.ok(censusEntities.size > 600, `census entity 가 비정상적으로 적다: ${censusEntities.size}`);
  const base = census.rosterIdentityTuples;
  const realEntity = census.rows[0].entity; // 실 census 에서 기계 추출한 corpus 루트 entity
  assert.ok(censusEntities.has(realEntity));

  // ─ 대칭차 자체 계약(변경 감지 누락 방어) ─────────────────────────────────
  // ⚠️ 좋은 계약부터 본다(순서가 mutation 특정성의 일부). 대칭차가 무력화되면 아래
  //   classify 시나리오가 연쇄로 뭉개져 어느 결함인지 구분되지 않는다(실측: G-2 뭉침).
  const newcomer = canonicalIdentityTuple({ name: "미등록신인", kboId: "99999", birthDate: "2005-01-01" });
  assert.ok(!censusEntities.has("미등록신인"), "전제 붕괴: 테스트 이름이 census entity 에 있다");
  assert.deepEqual(multisetSymmetricDiff(base, base), [], "무변경인데 대칭차가 비어있지 않다");
  assert.deepEqual(multisetSymmetricDiff(base, [...base, newcomer].sort()), [newcomer],
    "multiset 대칭차가 변경을 놓쳤다 — 영향 판정의 입력이 비어 모든 drift 가 통과한다");
  assert.deepEqual(multisetSymmetricDiff([...base, newcomer], base), [newcomer], "삭제 방향 대칭차 누락");

  // ─ 비영향 측(무인 통과가 유지돼야 한다) ───────────────────────────────────
  const addedNewcomer = classifyIdentityDrift(base, [...base, newcomer].sort(), censusEntities);
  assert.equal(addedNewcomer.affected, false,
    "비영향 변경(신규 이름이 census entity 밖)이 영향으로 과판정됐다 — 무인화가 회귀한다");
  const removedNewcomer = classifyIdentityDrift([...base, newcomer].sort(), base, censusEntities);
  assert.equal(removedNewcomer.affected, false, "census 밖 이름의 이탈이 영향으로 과판정됐다");

  // ─ 영향 측(fail-close 가 유지돼야 한다) ─────────────────────────────────────
  // 동명이인 생성: census entity 와 같은 이름의 신규 선수 → 후보수 1→2 → 판정 변경.
  const doppelganger = canonicalIdentityTuple({ name: realEntity, kboId: "88888", birthDate: "2004-04-04" });
  const addedDoppelganger = classifyIdentityDrift(base, [...base, doppelganger].sort(), censusEntities);
  assert.equal(addedDoppelganger.affected, true,
    "census entity 동명이인 생성이 영향으로 판정되지 않았다 — stale census 가 통과한다");
  if (addedDoppelganger.affected) {
    assert.equal(addedDoppelganger.reason, "affected_census_entities");
    assert.deepEqual(addedDoppelganger.affectedNames, [realEntity]);
  }
  // corpus 대상 선수의 신원 필드(생년 등) 변경: 기준 튜플을 변경해 교체.
  const entityTupleIndex = base.findIndex((tuple) => tupleName(tuple) === realEntity);
  assert.ok(entityTupleIndex >= 0, "전제 붕괴: census entity 가 기준 multiset 에 없다");
  const mutated = [...base];
  mutated[entityTupleIndex] = canonicalIdentityTuple({ name: realEntity, kboId: "77777", birthDate: "1990-09-09" });
  const changedEntity = classifyIdentityDrift(base, [...mutated].sort(), censusEntities);
  assert.equal(changedEntity.affected, true,
    "corpus 대상 선수의 신원 변경이 영향으로 판정되지 않았다");
  // 이탈: census entity 선수가 로스터에서 빠지면 후보수 1→0 → 영향.
  const removedEntity = classifyIdentityDrift(base, base.filter((_, index) => index !== entityTupleIndex), censusEntities);
  assert.equal(removedEntity.affected, true, "corpus 대상 선수 이탈이 영향으로 판정되지 않았다");

  // ─ fail-close 측 ────────────────────────────────────────────────────────────────
  const broken = classifyIdentityDrift(base, [...base, "not-json-tuple"], censusEntities);
  assert.equal(broken.affected, true, "판정 불가 튜플이 fail-close 되지 않았다");
  if (broken.affected) assert.equal(broken.reason, "unparseable");
  // ⚠️ 빈 기준 multiset 은 가드 제거 시에도 "전원 추가 = census entity 포함" 이라 우연히 affected 가
  //   된다(변별력 없음). 가드 제거를 변별하는 건 **빈 entity 집합** 쪽이다 — diff 0·entity 0이면
  //   가드 없는 구현은 비영향으로 떨어진다.
  assert.equal(classifyIdentityDrift([], base, censusEntities).affected, true, "빈 기준 multiset 이 fail-close 되지 않았다");
  assert.equal(classifyIdentityDrift(base, base, new Set()).affected, true, "빈 entity 집합이 fail-close 되지 않았다");

  ok("신원 drift 영향 판정 — 대칭차 계약 3종 · 비영향 PASS 2종 · 영향 fail-close 3종 · 판정불가 3종");
}

function run(): void {
  verifyFixtureProvenance();
  // ⚠️ 지문 **계약**을 census 정합성보다 먼저 본다. census 정합성도 지문 함수를 쓰므로,
  //   함수 결함 시 순서가 반대면 모든 변이가 "census 재생성 필요" 한 문구로 뭉쳐
  //   어떤 결함인지 구분되지 않는다(실측: F 축 변이 6개가 같은 문구로 뭉쳤다).
  verifyRosterFingerprintContract();
  verifyIdentityImpactContract();
  verifyCensusIntegrity();
  verifyBothLayouts();
  verifyLongCategoryBlock();
  verifyFlattenedFailClose();
  verifyAmbiguityDocuments();
  // ⚠️ 실행 순서가 mutation 특정성의 일부다. clause 결속 → 구제 반대가설 → 전건 census 순으로
  //   좁은 계약부터 본다. 반대로 두면 census 의 포괄 assertion 이 먼저 깨져서 어떤 결함인지
  //   구분되지 않는다(실측: 6개 변이가 같은 문구로 뭉쳤다).
  verifyBirthClauseBinding();
  verifyRescueDoesNotOpenDoor();
  verifyBirthDateRelationBinding();
  verifyBirthMismatchCensus();
  verifyStructuralHelpers();
  verifyTitleGate();
  console.log(`\nbaseball QA corpus identity PASS (${passed} 섹션)`);
}

run();
