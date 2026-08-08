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
  extractDocumentBirthDate,
  isYearBoundaryBirthDate,
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

  // ── 아래 4건은 **게이트가 본인 문서를 거부했던** 실측 결함 fixture 다 (2026-08-09).
  //   네 명 모두 나무위키 문서가 정확히 본인인데 로더에서 격리돼 서빙되지 않았다.

  // (a) 분류가 428자 — `야구 선수` 가 종전 300자 캐 **밖**에 있다.
  //     훈장·수상이 많은 베테랑일수록 분류가 길어져서 유명 선수부터 버려졌다.
  양의지: "양의지\n최근 수정 시각: 2026-08-02 15:02:13\n89\n편집 요청\n토론\n역사\n분류양의지경찰 야구단/전역2006년 데뷔1987년 출생광산구 출신 인물제주 양씨송정동초등학교 출신무등중학교 출신광주진흥고등학교 출신우투우타포수지명타자NC 다이노스/은퇴, 이적두산 베어스/현역KBO 신인상KBO 리그의 사이클링 히트 달성자KBO 한국시리즈 MVPKBO 타격왕KBO 장타왕KBO 출루왕KBO 미스터 올스타대한민국의 아시안 게임 메달리스트2018 자카르타·팔렘방 아시안 게임 메달리스트대한민국의 올림픽 야구 참가 선수2020 도쿄 올림픽 야구 참가 선수대한민국의 월드 베이스볼 클래식 참가 선수2017 월드 베이스볼 클래식 참가 선수2023 월드 베이스볼 클래식 참가 선수대한민국의 WBSC 프리미어 12 참가 선수2015 WBSC 프리미어 12 참가 선수2019 WBSC 프리미어 12 참가 선수한국프로야구선수협회 회장야구 주장인터넷 밈/야구 선수/대한민국\n양의지 1987년 6월 5일",

  // (b~d) 해 경계 생년 불일치 — KBO 등록과 나무위키 기준이 다를 뿐 같은 사람이다.
  최형우: "최형우\n최근 수정 시각: 2026-08-01 22:40:50\n71\n편집\n토론\n역사\n분류최형우대한민국의 남자 야구 선수1984년 출생2002년 데뷔완산구 출신 인물전주진북초등학교 출신전주동중학교 출신전주고등학교 출신포수외야수지명타자우투좌타경찰 야구단/전역해태-KIA 타이거즈/은퇴, 이적삼성 라이온즈/현역KBO 신인상KBO 타격왕KBO 안타왕KBO 홈런왕KBO 타점왕KBO 장타왕KBO 출루왕KBO 리그의 사이클링 히트 달성자KBO 미스터 올스타성구회 멤버2017 월드 베이스볼 클래식 참가 선수\n최형우 1984년 1월 18일",
  장성우: "장성우\n최근 수정 시각: 2026-08-04 10:06:15\n22\n편집\n토론\n역사\n분류장성우대한민국의 남자 야구 선수1989년 출생2009년 데뷔사하구 출신 인물감천초등학교(부산) 출신경남중학교 출신경남고등학교 출신우투우타포수롯데 자이언츠/은퇴, 이적캔버라 캐벌리/은퇴, 이적경찰 야구단/전역kt wiz/현역야구 주장\n장성우 1989년 12월 17일",
  김태혁: "김태혁\n최근 수정 시각: 2026-08-04 21:25:49\n29\n편집\n토론\n역사\n분류김태혁대한민국의 남자 야구 선수1987년 출생2008년 데뷔대전광역시 출신 인물자양중학교 출신신일고등학교 출신한국방송통신대학교 출신우완 투수우투우타삼성 라이온즈/은퇴, 이적우리-서울-넥센-키움 히어로즈/은퇴, 이적상무 피닉스 야구단/전역SK 와이번스-SSG 랜더스/은퇴, 이적롯데 자이언츠/현역KBO 홀드왕개명한 인물\n김태혁 1987년 12월 30일",
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

/**
 * (6) **본인 문서를 거부하던 게이트 결함 2종** — 2026-08-09 실측.
 *
 * ⚠️ 이 섹션이 없으면 수정을 통째로 되돌려도 게이트가 GREEN 이다(mutation 실측).
 *   fixture 만 늘리고 assert 를 안 하면 검출력이 0 이다 — 실제로 그랬고 mutation 이 잡았다.
 */
function verifySelfDocumentRescue(): void {
  // ── (a) 분류 스캔 길이 상한 ─────────────────────────────────
  //   `양의지` 분류는 428자라 `대한민국의 남자 야구 선수` 가 종전 300자 캐 **밖**에 있었다.
  //   훈장·수상이 많은 베테랑일수록 분류가 길어져서 유명 선수부터 버려졌다.
  const yangCats = extractCorpusCategories(REAL.양의지);
  assert.ok(
    yangCats.length > 300,
    `분류가 ${yangCats.length}자로 잘렸다 — 스캔 상한이 되살아났다`,
  );
  assert.equal(
    hasBaseballPlayerCategory(yangCats), true,
    "300자 밖의 `야구 선수` 분류를 못 본다",
  );
  const yang = verifyCorpusPlayerIdentity({
    text: REAL.양의지, rosterBirthYear: "1987", rosterBirthDate: "1987-06-05",
    seedName: "양의지", documentTitle: "양의지 - 나무위키",
  });
  assert.equal(yang.ok, true, `본인 문서가 거부됐다: ${JSON.stringify(yang)}`);

  // ── (b) 해 경계 생년 불일치(빠른생일·음력) ───────────────────────
  //   KBO 등록과 나무위키 분류가 서로 다른 기준을 쓰는 것뿐, 같은 사람이다.
  for (const [name, text, birthDate] of [
    ["최형우", REAL.최형우, "1983-12-16"],   // 문서 1984-01-18 (33일 차)
    ["장성우", REAL.장성우, "1990-01-17"],   // 문서 1989-12-17 (31일 차)
    ["김태혁", REAL.김태혁, "1988-01-02"],   // 문서 1987-12-30 (3일 차)
  ] as const) {
    const verdict = verifyCorpusPlayerIdentity({
      text, rosterBirthYear: birthDate.slice(0, 4), rosterBirthDate: birthDate,
      seedName: name, documentTitle: `${name} - 나무위키`,
    });
    assert.equal(verdict.ok, true, `${name} 본인 문서가 거부됐다: ${JSON.stringify(verdict)}`);
  }

  // ── (c) 반대가설 — 느슨해졌는지 확인한다 ─────────────────────────
  //   ⚠️ "1년 차이는 허용"이 되면 **동명이인 형제·부자를 섞는다**. 근거를 요구하므로
  //   아래는 전부 거부되어야 한다.
  assert.equal(
    isYearBoundaryBirthDate({ year: 1984, month: 6, day: 15 }, "1983-06-20"), false,
    "달이 해 경계가 아니면(6월) 빠른생일로 설명되지 않는다",
  );
  assert.equal(
    isYearBoundaryBirthDate({ year: 1984, month: 12, day: 1 }, "1982-12-01"), false,
    "2년 차이는 빠른생일이 아니다",
  );
  // ⚠️ **연도차 제약을 직접** 검증한다 (mutation C-C 가 GREEN 이었던 구멍).
  //   위 60일 검사가 2년차를 대신 잡아서 "연도차 1" 조건을 느슨하게 바꿔도 게이트가
  //   못 봤다. **같은 해**(연도차 0)는 60일 이내여도 이 함수가 false 여야 한다 —
  //   생년이 같으면 애초에 `matchesBirthYear` 가 통과시켰을 경로라 구제 대상이 아니다.
  assert.equal(
    isYearBoundaryBirthDate({ year: 1990, month: 12, day: 15 }, "1990-12-01"), false,
    "연도차 0 은 구제 대상이 아니다 — 연도차 제약이 느슨해졌다",
  );
  // ⚠️ **해 경계 월 요구를 직접** 검증한다 (mutation C-D 가 GREEN 이었던 구멍).
  //   연도차 1 · 60일 이내이면서 **월이 경계가 아닌** 조합이 실제로 존재한다:
  //   문서 1984-02-15 · 로스터 1983-12-20 = 57일. 빠른생일로 설명되지 않으므로 거부다.
  assert.equal(
    isYearBoundaryBirthDate({ year: 1984, month: 2, day: 15 }, "1983-12-20"), false,
    "문서가 2월인데 통과했다 — 해 경계 월 요구가 사라졌다",
  );
  assert.equal(
    isYearBoundaryBirthDate({ year: 1984, month: 1, day: 10 }, "1983-11-25"), false,
    "로스터가 11월인데 통과했다 — 해 경계 월 요구가 사라졌다",
  );
  assert.equal(
    isYearBoundaryBirthDate({ year: 1984, month: 1, day: 31 }, "1983-12-01"), false,
    "달은 맞아도 실제 간격이 60일을 넘으면 다른 사람이다",
  );
  assert.equal(
    isYearBoundaryBirthDate({ year: 1984, month: 1, day: 18 }, undefined), false,
    "로스터 날짜가 없으면 구제하지 않는다(없는 근거로 통과시키지 않는다)",
  );
  //   날짜를 안 넘기면(종전 호출부) 종전과 똑같이 거부된다 — 호환 계약.
  const noDate = verifyCorpusPlayerIdentity({
    text: REAL.최형우, rosterBirthYear: "1983",
    seedName: "최형우", documentTitle: "최형우 - 나무위키",
  });
  assert.equal(noDate.ok, false, "로스터 날짜 없이 통과하면 근거 없는 구제다");
  if (!noDate.ok) assert.equal(noDate.reason, "birth_year_mismatch");

  //   본문 생년월일 추출은 **연도만 있는 항목**을 잡으면 안 된다(`2002년 데뷔`).
  assert.deepEqual(
    extractDocumentBirthDate(REAL.최형우), { year: 1984, month: 1, day: 18 },
    "인포박스 생년월일을 읽지 못했다",
  );
  assert.equal(
    extractDocumentBirthDate("분류김도영대한민국의 남자 야구 선수2003년 출생2022년 데뷔"), undefined,
    "연도만 있는 분류를 생년월일로 오인했다",
  );

  //   그리고 **진짜 타인 문서**는 여전히 거부되어야 한다(구제가 문을 열지 않음).
  const stranger = verifyCorpusPlayerIdentity({
    text: REAL.김도영, rosterBirthYear: "1990", rosterBirthDate: "1990-06-01",
    seedName: "김도영", documentTitle: "김도영 - 나무위키",
  });
  assert.equal(stranger.ok, false, "생년이 13년 어긋난 문서가 통과했다");
  if (!stranger.ok) assert.equal(stranger.reason, "birth_year_mismatch");

  ok("본인 문서 구제 — 분류 상한 제거 / 해 경계 빠른생일(근거 요구) / 반대가설 5종 거부");
}

function run(): void {
  verifyRealContaminationBlocked();
  verifyTitleGate();
  verifyBirthYearPolicy();
  verifyCategoryAbsent();
  verifyCategoryNormalization();
  verifySelfDocumentRescue();
  console.log(`\nbaseball QA corpus identity PASS (${passed} 섹션)`);
}

run();
