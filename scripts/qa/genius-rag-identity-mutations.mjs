#!/usr/bin/env node
//
// `qa:genius-rag-identity` 게이트의 **검출력 증명** — 결함주입 runner.
//
// ⚠️ 왜 `--selftest` 만으로는 부족한가 (M90, 2026-08-17 하루 5건 재발).
//   selftest 는 assertion 배선만 증명한다. "이 게이트가 **실제 결함**을 잡는가"는
//   배포 소스를 진짜로 훼손해 봐야 안다. 그래서 변이마다 배포 파일을 고치고,
//   게이트가 **지정된 assertion 문구**로 RED 인지 본다.
//
// ⚠️ exit code 가 아니라 assertion 문구로 판정한다 (기존 unbound-name runner 계약과 동일).
//   변이가 만든 컴파일 오류까지 "검출 성공" 으로 세면 게이트가 그 결함을 본 게 아닌데도 GREEN 이 된다.
//
// 계약: 원본은 시작 시 백업하고 매 변이 후 복원한다(정상/예외/시그널 모두).
//
// 실행: node scripts/qa/genius-rag-identity-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const RETRIEVE = "src/lib/baseball-qa/rag/retrieve.ts";
const SERVER = "src/lib/baseball-qa/server.ts";

for (const target of [PIPELINE, RETRIEVE, SERVER]) {
  if (!fs.existsSync(target)) {
    console.error(`❌ ${target} 이 없다 — repo 루트에서 실행해야 한다`);
    process.exit(1);
  }
}

const originals = new Map([
  [PIPELINE, fs.readFileSync(PIPELINE, "utf8")],
  [RETRIEVE, fs.readFileSync(RETRIEVE, "utf8")],
  [SERVER, fs.readFileSync(SERVER, "utf8")],
]);

const restore = () => {
  for (const [file, content] of originals) fs.writeFileSync(file, content);
};
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });

/**
 * 각 변이는 실제 결함을 재현한다:
 *  M1 배선 끊김        — answerQuestion 이 identityBlock 을 안 넘긴다 (2026-08-19 원래 상태)
 *  M2 프롬프트 미적재  — extras 를 받고도 프롬프트 본문에 안 싣는다 (조용한 무력화)
 *  M3 포지션 누락      — 블록에서 포지션을 뺀다 (오귀속을 막을 축 소멸)
 *  M4 동명이인 누락    — "주인공 아님" 목록을 뺀다 (제3자 구분 신호 소멸)
 *  M5 잘못된 결속      — 항상 첫 로스터 선수로 결속한다 (다른 사람 문서로 답하는 사고)
 *  M6 배치 역전        — identity 블록을 자료보다 앞에 둔다 (배치 계약 위반)
 *  M7 미결속 빈 블록   — roster 밖 kboId 에도 블록을 만든다 (근거 없는 결속)
 */
const MUTATIONS = [
  {
    // 문장 분리를 없애면 답변 전체가 한 덩어리가 되어 제3자 언급까지 귀속으로 오판한다.
    id: "M13 문장 분리 제거(과잉 차단)",
    file: PIPELINE,
    find: `  const sentences = answer.split(/(?<=[.!?\\n])\\s*/).filter((line) => line.trim().length > 0);`,
    replace: `  const sentences = [answer];`,
    expect: "다른 선수 이름이 든 문장을 주인공 귀속으로 오판했다",
  },
  {
    // 🔴 삼순 4차 P0: 파이프라인이 신호를 만들어도 **실제 전송 지점**이 빠뜨리면
    //   재생성은 직전과 같은 프롬프트가 된다 — 비용만 쓰고 같은 오답을 받는다.
    id: "M14 server 어댑터 identityConflict 미전달",
    file: SERVER,
    find: `          identityConflict: extras?.identityConflict,`,
    replace: "",
    expect: "server 어댑터가 실제 Gemini 요청에 identityConflict",
  },
  {
    id: "M15 server 어댑터 identityBlock 미전달",
    file: SERVER,
    find: `          identityBlock: extras?.identityBlock,`,
    replace: "",
    expect: "server 어댑터가 identityBlock 을 전달하지 않는다",
  },
  {
    // `내야수` 안의 `야수` 가 상위범주로 오인돼 충돌이 통과하던 확정 false-negative.
    // ⚠️ 정규식 **순서만** 바꾸는 변이는 무의미하다 — leftmost 매칭이라 어느 순서든
    //   `내야수` 위치에서 3글자가 먼저 잡힌다(동작 불변 = 관측 불가). 실제 결함은
    //   종전의 includes 기반 토큰화이므로 그것을 주입한다.
    id: "M16 includes 기반 토큰화(부분문자열 중복 매칭)",
    file: PIPELINE,
    find: `  for (const match of text.matchAll(POSITION_PATTERN)) {
    found.push({ token: match[0], index: match.index ?? 0 });
  }`,
    replace: `  for (const token of ["투수", "포수", "내야수", "외야수", "야수"]) {
    const idx = text.indexOf(token);
    if (idx >= 0) found.push({ token, index: idx });
  }`,
    expect: "부분 문자열(야수) 오인",
  },
  {
    // 이름 없는 후속 문장을 통째로 버리면 `김민준 선수입니다. 포지션은 내야수입니다.` 가 샌다.
    id: "M17 이름 없는 후속 문장 미검사",
    file: PIPELINE,
    find: `    if (sentence.includes(identity.name)) subjectContext = true;`,
    replace: `    subjectContext = sentence.includes(identity.name);`,
    expect: "이름 없는 후속 문장",
  },
  {
    // 반대 방향 — 후속 문장을 전부 귀속으로 보면 제3자 언급이 오탐된다.
    id: "M18 후속 문장 서술어 판정 제거(과잉 차단)",
    file: PIPELINE,
    find: `      const attributed = tokenizePositions(sentence)
        .filter((t) => isAttributivePredicate(sentence, t.token, t.index));`,
    replace: `      const attributed = tokenizePositions(sentence);`,
    expect: "제3자 언급을 귀속으로 오판했다",
  },
  {
    id: "M19 team 충돌 검출 제거",
    file: PIPELINE,
    find: `      const teams = attributedTeams(sentence);`,
    replace: `      const teams = [] as string[];`,
    // M축(양방향 team 오귀속)이 먼저 잡는다 — P2 와 같은 team 검출 축이라 정당하다.
    expect: "소속 오귀속",
  },
  {
    // 별칭을 정규 코드로 접지 않으면 `에스에스지` 가 SSG 와 다른 값으로 보여 정상이 죽는다.
    id: "M20 team 별칭 정규화 제거",
    file: PIPELINE,
    find: `          hit.add(canonical);`,
    replace: `          hit.add(alias);`,
    expect: "같은 구단의 다른 표기를 오귀속으로 셌다",
  },
  {
    // 실제로 냈던 회귀 — 한쪽만 정규화하면 정상 표기가 충돌로 오판된다.
    id: "M21 identity.team 미정규화(한쪽만 접기)",
    file: PIPELINE,
    find: `      const subjectTeam = canonicalizeTeam(identity.team);`,
    replace: `      const subjectTeam = identity.team;`,
    expect: "풀네임 구단 표기를 오귀속으로 셌다",
  },
  {
    // 🔴 삼순 5차 실재 결함: 구단 "등장"을 소속으로 세면 상대팀 문장이 정상인데 죽는다.
    id: "M22 구단 등장만으로 소속 판정(귀속 마커 무시)",
    file: PIPELINE,
    find: `        if (TEAM_AFFILIATION_AFTER.test(sentence.slice(from))
          || TEAM_AFFILIATION_BEFORE.test(sentence.slice(0, index))) {`,
    replace: `        if (true) {`,
    expect: "소속이 아닌 구단 언급을 오귀속으로 셌다",
  },
  {
    id: "M7 미결속 kboId 빈 블록 생성",
    file: PIPELINE,
    find: `  if (!player) return null;`,
    replace: `  if (!player) return \`kboId: \${candidate.entityId}\`;`,
    expect: "roster 밖 kboId 인데 블록을 만들었다",
  },
];

function runGate() {
  const res = spawnSync("npm", ["run", "--silent", "qa:genius-rag-identity"], {
    encoding: "utf8",
    env: process.env,
  });
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

// 0) 원본은 GREEN 이어야 한다 — 여기서 RED 면 변이 결과를 해석할 수 없다.
const baseline = runGate();
if (!/genius-rag-identity-binding-smoke PASS/.test(baseline)) {
  console.error("❌ 원본 상태에서 게이트가 GREEN 이 아니다 — 변이 판정 불가");
  console.error(baseline.slice(-1500));
  process.exit(1);
}
console.log("PASS baseline GREEN");

let detected = 0;
for (const mutation of MUTATIONS) {
  const source = originals.get(mutation.file);
  if (!source.includes(mutation.find)) {
    console.error(`❌ ${mutation.id}: 변이 앵커를 찾지 못했다 — 소스가 바뀌었으면 변이도 갱신해야 한다`);
    console.error(`   anchor: ${mutation.find.slice(0, 80)}…`);
    restore();
    process.exit(1);
  }
  fs.writeFileSync(mutation.file, source.replace(mutation.find, mutation.replace));
  const output = runGate();
  restore();

  const red = output.includes(mutation.expect);
  if (red) {
    detected += 1;
    console.log(`PASS ${mutation.id} → 게이트 RED (기대 assertion 검출)`);
  } else {
    console.error(`FAIL ${mutation.id} → 게이트가 이 결함을 잡지 못했다`);
    console.error(`   기대 문구: ${mutation.expect}`);
    console.error(output.slice(-1200));
  }
}

console.log(`\n결함주입 검출: ${detected}/${MUTATIONS.length}`);
if (detected !== MUTATIONS.length) process.exit(1);
console.log("genius-rag-identity-mutations PASS");
