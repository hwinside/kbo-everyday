#!/usr/bin/env node
//
// `qa:genius-team-copy` 게이트의 **검출력 증명** — 결함주입 runner (삼순 2026-08-14 2차 P0).
//
// 왜 필요한가: 게이트가 tsx 실로드·typeof 만 보면 import 삭제(TS2304)가 false-green 이고,
// 문자열 리터럴끼리의 SHA 비교는 카피·sourceId 변조를 놓친다. 그래서 **배포 소스를 실제로
// 훼손**하고 게이트(`npm run -s qa:genius-team-copy` = tsc --noEmit 전용 tsconfig + smoke)가
// 지정된 assertion 문구로 RED 나는지 확인한다.
//
// ⚠️ 외부 프로세스는 `npm` 하나만 쓴다 — Vercel 빌드 이미지에 diff/perl 이 없어 bash runner 가
//   통째로 깨진 실측(2026-08-09) 재발 방지.
// ⚠️ exit code 가 아니라 **assertion 문구**로 판정한다(삼순 2026-08-08 ④) — 무관한 크래시를
//   "검출 성공"으로 세지 않는다. 단 M1(import 삭제)은 tsc 컴파일 오류 자체가 기대 결함이므로
//   기대 문구가 `TS2304` 다.
//
// 실행: node scripts/qa/baseball-genius-team-copy-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const TARGETS = [
  "src/lib/baseball-qa/server.ts",
  "src/lib/constants/baseball-genius-team-copy.ts",
];
for (const t of TARGETS) {
  if (!fs.existsSync(t)) {
    console.error(`❌ ${t} 이 없다 — repo 루트에서 실행해야 한다`);
    process.exit(1);
  }
}
const ORIGINALS = new Map(TARGETS.map((t) => [t, fs.readFileSync(t, "utf8")]));
const restore = () => { for (const [t, src] of ORIGINALS) fs.writeFileSync(t, src); };
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

const MUTATIONS = [
  {
    name: "M1 renderTeamFanCopy import 삭제 (원 사고 재현 — TS2304)",
    file: "src/lib/baseball-qa/server.ts",
    from: 'import { renderTeamFanCopy } from "@/lib/constants/baseball-genius-team-copy";\n',
    to: "",
    // tsc 가 기대 검출자다 — 유일하게 풀 게이트(tsc 포함)를 탄다. 나머지 변이는 smoke 검출이므로
    // smoke-only 로 돌려 prebuild 비용을 tsc 2회(게이트+M1)로 묶는다.
    script: "qa:genius-team-copy",
    expect: "TS2304",
  },
  {
    name: "M2 카피 본문 1글자 변조 (payload digest RED)",
    file: "src/lib/constants/baseball-genius-team-copy.ts",
    from: "LG 트윈스는 1982년 MBC 청룡으로 출발했습니다.",
    to: "LG 트윈스는 1983년 MBC 청룡으로 출발했습니다.",
    expect: "payload canonical digest",
  },
  {
    name: "M3 sourceId 결속 변조 (payload digest 또는 결속 RED)",
    file: "src/lib/constants/baseball-genius-team-copy.ts",
    from: '{ id: "DS-3", text: "두산의 홈 구장은 잠실야구장입니다.", sourceId: "DS_STADIUM" }',
    to: '{ id: "DS-3", text: "두산의 홈 구장은 잠실야구장입니다.", sourceId: "DS_BRAND" }',
    expect: "payload canonical digest",
  },
  {
    name: "M4 pipeline greeting 가드 훼손 (실실행 RED — regex 검사였다면 false-green이던 변이)",
    file: "src/lib/baseball-qa/pipeline.ts",
    // ⚠️ 앵커는 pipeline 의 현재 문면을 그대로 복사한다 — 조건이 늘면(streakFixed 등)
    // 앵커가 조용히 MISS 되고(anchor=0) mutation 이 검증력 없이 FAIL 한다(2026-08-15 실측).
    from: 'if (!streakFixed && route === "ack" && isGreetingPhrase(question) && deps.pickTeamFanCopy) {',
    to: 'if (false && route === "ack" && isGreetingPhrase(question) && deps.pickTeamFanCopy) {',
    expect: "pipeline 실실행",
  },
];
// M4 는 pipeline.ts 도 훼손하므로 백업 대상에 추가한다.
const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
ORIGINALS.set(PIPELINE, fs.readFileSync(PIPELINE, "utf8"));

let failed = 0;
for (const m of MUTATIONS) {
  const src = ORIGINALS.get(m.file);
  const occurrences = src.split(m.from).length - 1;
  if (occurrences !== 1) {
    console.error(`❌ ${m.name}: 앵커가 ${occurrences}회 매치 (1회 필요) — 패턴이 낡았다`);
    failed++;
    continue;
  }
  fs.writeFileSync(m.file, src.replace(m.from, m.to));
  const run = spawnSync("npm", ["run", "-s", m.script ?? "qa:genius-team-copy:smoke-only"], { encoding: "utf8" });
  restore();
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const red = run.status !== 0;
  const evidenced = output.includes(m.expect);
  if (red && evidenced) {
    console.log(`PASS 결함주입 RED: ${m.name}`);
  } else {
    failed++;
    console.error(`FAIL 결함주입: ${m.name} — status=${run.status} evidence(${m.expect})=${evidenced}`);
    console.error(output.split("\n").filter((l) => l.includes("FAIL") || l.includes("error TS")).slice(0, 5).join("\n"));
  }
}

restore();
if (failed > 0) {
  console.error(`\nFAIL team-copy mutations: ${failed}건`);
  process.exit(1);
}
console.log("\nPASS team-copy mutations: 4/4 RED (import 삭제·payload 변조·결속 변조·배선 훼손)");
