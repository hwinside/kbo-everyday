/**
 * A17 corpus 신원 게이트 회귀.
 *
 * 실측 배경(2026-08-02): corpus 선수 루트문서 60건 중 8건(13%)이 엉뚱한 문서였다.
 * 크롤러가 이름 문자열만 갖고 긁기 때문이다. 이 게이트가 없으면 "오스틴이 누구야?"에
 * 텍사스주 주도를 설명하게 된다 — 저장 100%의 목적(정확성)과 정반대다.
 *
 * 아래 fixture는 **실제 corpus에서 뽑은 분류 문자열**을 쓴다. 합성 문자열로만 검증하면
 * 실제 문서 모양이 바뀌었을 때 게이트가 조용히 무력해진다.
 */
import assert from "node:assert/strict";

import {
  extractCorpusCategories,
  normalizeCorpusTitle,
  titleMatchesSeed,
  hasBaseballPlayerCategory,
  isAmbiguityDocument,
  matchesBirthYear,
  verifyCorpusPlayerIdentity,
} from "../../src/lib/baseball-qa/rag/corpus-identity";

let passed = 0;
const ok = (label: string): void => {
  passed += 1;
  console.log(`PASS ${label}`);
};

/** 실제 corpus 실측 텍스트(머리 부분). */
const REAL = {
  김도영: "김도영 최근 수정 시각: 2026-08-01 12:45:52 113 편집 요청 토론 역사 분류김도영대한민국의 남자 야구 선수2003년 출생2022년 데뷔남구(전남광주) 출신 인물광주대성초등학교 출신내야수우투우타KIA 타이거즈/현역",
  오스틴: "오스틴 최근 수정 시각: 2026-06-24 18:31:06 4 편집 토론 역사 분류동음이의어성씨/영미권이름/영미권 1. 미국 텍사스주의 주도 오스틴 2. 영국의 자동차 브랜드 3. 포스트 말론의 다섯 번째 정규 앨범",
  강백호: "강백호 최근 수정 시각: 2026-07-30 11:02:11 9 편집 토론 역사 분류동명이인동음이의어 1. 슬램덩크의 등장인물 2. 야구선수",
  레이예스: "레이예스 최근 수정 시각: 2026-05-02 09:11:00 2 편집 토론 역사 분류성씨/로망스어권 스페인어권의 성씨이다.",
} as const;

/** (1) 실제 오염 문서가 실제로 걸러지는가 — 이 게이트의 존재 이유. */
function verifyRealContaminationBlocked(): void {
  const 도영 = verifyCorpusPlayerIdentity({
    text: REAL.김도영, rosterBirthYear: "2003",
    seedName: "김도영", documentTitle: "김도영 - 나무위키",
  });
  assert.equal(도영.ok, true, "정상 선수 문서는 통과해야 한다");

  const 오스틴 = verifyCorpusPlayerIdentity({ text: REAL.오스틴, rosterBirthYear: "1993" });
  assert.equal(오스틴.ok, false);
  if (!오스틴.ok) assert.equal(오스틴.status, "ambiguous", "동음이의 문서는 버리지 않고 격리한다");

  // 강백호는 동음이의 문서인데 본문에 '야구선수'가 들어있다.
  // 야구분류를 먼저 보면 통과해버린다 — 판정 순서가 계약이다.
  const 강백호 = verifyCorpusPlayerIdentity({ text: REAL.강백호, rosterBirthYear: "1999" });
  assert.equal(강백호.ok, false, "동음이의 문서에 '야구선수'가 섞여 있어도 통과하면 안 된다");
  if (!강백호.ok) assert.equal(강백호.status, "ambiguous");

  const 레이예스 = verifyCorpusPlayerIdentity({ text: REAL.레이예스, rosterBirthYear: "1994" });
  assert.equal(레이예스.ok, false);
  if (!레이예스.ok) assert.equal(레이예스.reason, "not_baseball_player_document");

  ok("실측 오염 차단 — 김도영 통과 / 오스틴·강백호 격리 / 레이예스 거부");
}

/** (2) 생년 대조: 로스터·문서 양쪽 근거가 없으면 추측하지 않고 격리한다. */
function verifyBirthYearPolicy(): void {
  const categories = extractCorpusCategories(REAL.김도영);
  assert.equal(matchesBirthYear(categories, "2003"), true);
  assert.equal(matchesBirthYear(categories, "1999"), false);
  assert.equal(matchesBirthYear(categories, undefined), null, "로스터 생년이 없으면 판정하지 않는다");
  assert.equal(matchesBirthYear("분류성씨/영미권", "2003"), null, "문서에 출생 분류가 없으면 판정하지 않는다");

  // 생년이 어긋나면 동명이인 오매칭이므로 거부한다.
  const wrong = verifyCorpusPlayerIdentity({ text: REAL.김도영, rosterBirthYear: "1990" });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "birth_year_mismatch");

  const rosterUnknown = verifyCorpusPlayerIdentity({
    text: REAL.김도영, rosterBirthYear: undefined,
    seedName: "김도영", documentTitle: "김도영 - 나무위키",
  });
  assert.equal(rosterUnknown.ok, false);
  if (!rosterUnknown.ok) assert.equal(rosterUnknown.reason, "roster_birth_year_absent");

  const documentUnknown = verifyCorpusPlayerIdentity({
    text: "분류대한민국의 야구 선수KIA 타이거즈/현역", rosterBirthYear: "2003",
    seedName: "김도영", documentTitle: "김도영 - 나무위키",
  });
  assert.equal(documentUnknown.ok, false);
  if (!documentUnknown.ok) assert.equal(documentUnknown.reason, "document_birth_year_absent");
  ok("생년 대조 — 일치/불일치/로스터 결측/문서 결측 fail-close");
}

/** (3) 분류 자체가 없는 문서는 fail-close. */
function verifyCategoryAbsent(): void {
  // 주의: fixture 본문에 '분류'라는 낱말이 들어가면 추출기가 그걸 잡아 이 케이스가 성립하지 않는다.
  // (실제로 첫 작성 때 "분류 라인이 없는"이라고 써서 회귀가 FAIL로 잡아냈다.)
  const verdict = verifyCorpusPlayerIdentity({ text: "제목만 있고 카테고리 표기가 없는 본문입니다.", rosterBirthYear: "2000" });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "category_absent");
  assert.equal(extractCorpusCategories(""), "");
  ok("분류 부재 fail-close");
}

/** (4) 표기 흔들림 흡수 — '야구 선수'와 '야구선수'를 모두 인정. */
function verifyCategoryNormalization(): void {
  assert.equal(hasBaseballPlayerCategory("대한민국의 남자 야구 선수"), true);
  assert.equal(hasBaseballPlayerCategory("야구선수"), true);
  assert.equal(hasBaseballPlayerCategory("성씨/영미권"), false);
  assert.equal(isAmbiguityDocument("동음이의어성씨"), true);
  assert.equal(isAmbiguityDocument("동명이인"), true);
  assert.equal(isAmbiguityDocument("대한민국의 남자 야구 선수"), false);
  ok("분류 표기 정규화");
}

/** (5) 제목 대조 게이트 (삼순 NO-GO ①) — 분류만으로는 타인 문서를 못 걸러낸다. */
function verifyTitleGate(): void {
  assert.equal(normalizeCorpusTitle("김도영 - 나무위키"), "김도영");
  assert.equal(titleMatchesSeed("김도영", "김도영 - 나무위키"), true);
  // 풀네임 문서는 등록명을 토큰으로 포함한다(실측: 올러 -> 아담 올러).
  assert.equal(titleMatchesSeed("올러", "아담 올러 - 나무위키"), true);
  // 전혀 다른 선수 문서는 거부된다.
  assert.equal(titleMatchesSeed("김도영", "문보경 - 나무위키"), false);

  // 핵심: 분류가 정상인 **다른 선수** 문서는 생년도 분류도 통과하므로
  // 제목 대조가 없으면 fail-open 된다.
  const other = verifyCorpusPlayerIdentity({
    text: REAL.김도영, rosterBirthYear: "2003",
    seedName: "문보경", documentTitle: "김도영 - 나무위키",
  });
  assert.equal(other.ok, false, "다른 선수 문서에 도착했는데 통과하면 오귀속이다");
  if (!other.ok) {
    assert.equal(other.status, "ambiguous");
    assert.equal(other.reason, "document_title_mismatch");
  }
  // 제목 정보가 없으면 귀속 근거가 없으므로 격리한다.
  const noTitle = verifyCorpusPlayerIdentity({ text: REAL.김도영, rosterBirthYear: "2003" });
  assert.equal(noTitle.ok, false);
  if (!noTitle.ok) assert.equal(noTitle.reason, "document_title_absent");
  assert.equal(titleMatchesSeed("레이예스", "레예스 - 나무위키"), true);
  assert.equal(titleMatchesSeed("벤자민", "벤저민 - 나무위키"), true);
  ok("제목 대조 게이트 — 타인 문서 격리 / 풀네임·표기차 허용 / 정보없으면 건너뜀");
}

function run(): void {
  verifyRealContaminationBlocked();
  verifyTitleGate();
  verifyBirthYearPolicy();
  verifyCategoryAbsent();
  verifyCategoryNormalization();
  console.log(`\nbaseball QA corpus identity PASS (${passed} 섹션)`);
}

run();
