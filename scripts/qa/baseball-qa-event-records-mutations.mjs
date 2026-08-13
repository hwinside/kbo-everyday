#!/usr/bin/env node
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const EVENT = "src/lib/baseball-qa/stats/event-records.ts";
const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const DATA = "data/baseball-qa/kbo-event-records-2026.json";
const SMOKE = "scripts/qa/baseball-qa-event-records-smoke.ts";
const MUTATIONS = [
  {
    name: "m1 snapshot sha 검증 제거 — 변조 데이터 통과",
    file: EVENT,
    from: '  if (createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== sha256) return false;',
    to: "  void unsigned;",
  },
  {
    name: "m2 복수 순번 차단 제거 — 첫 순번으로 오결속",
    file: EVENT,
    from: '  if (ordinals.length > 1) return null;',
    to: '  void ordinals.length;',
  },
  {
    name: "m2a 선수 intent 신호 제거 — 불일치 순번으로 오결속",
    file: EVENT,
    from: '  const intentCount = Number(named.length === 1) + Number(Boolean(ordinal)) +',
    to: '  const intentCount = 0 + Number(Boolean(ordinal)) +',
  },
  {
    name: "m2b 순번 intent 신호 제거 — 선수·최초와 경쟁해도 오결속",
    file: EVENT,
    from: '  const intentCount = Number(named.length === 1) + Number(Boolean(ordinal)) +',
    to: '  const intentCount = Number(named.length === 1) + 0 +',
  },
  {
    name: "m2c 최초 intent 신호 제거 — 최근과 경쟁해도 오결속",
    file: EVENT,
    from: '    Number(hasFirst) + Number(hasLatest) + Number(hasCount) + Number(hasList);',
    to: '    0 + Number(hasLatest) + Number(hasCount) + Number(hasList);',
  },
  {
    name: "m2d 최근 intent 신호 제거 — 최초·순번과 경쟁해도 오결속",
    file: EVENT,
    from: '    Number(hasFirst) + Number(hasLatest) + Number(hasCount) + Number(hasList);',
    to: '    Number(hasFirst) + 0 + Number(hasCount) + Number(hasList);',
  },
  {
    name: "m2e count intent 신호 제거 — 순번과 경쟁해도 오결속",
    file: EVENT,
    from: '    Number(hasFirst) + Number(hasLatest) + Number(hasCount) + Number(hasList);',
    to: '    Number(hasFirst) + Number(hasLatest) + 0 + Number(hasList);',
  },
  {
    name: "m2f count 긴 토큰 소비 순서 회귀 — 총몇번에서 번 잔여",
    file: EVENT,
    from: '|총몇번|총몇차례|총몇명|몇번|몇차례|몇명|총몇|개수|횟수|',
    to: '|몇번|몇차례|몇명|총몇|총몇번|총몇차례|총몇명|개수|횟수|',
  },
  {
    name: "m2g 전체목록 원자 소비 제거 — 지원 list 과차단",
    file: EVENT,
    from: '|기록|전체목록|달성선수|목록|전부|',
    to: '|기록|달성선수|목록|전부|',
  },
  {
    name: "m2h 달성선수 원자 소비 제거 — 지원 list 과차단",
    file: EVENT,
    from: '|기록|전체목록|달성선수|목록|전부|',
    to: '|기록|전체목록|목록|전부|',
  },
  {
    name: "m2i list intent 신호 제거 — first·ordinal과 경쟁해도 오결속",
    file: EVENT,
    from: '    Number(hasFirst) + Number(hasLatest) + Number(hasCount) + Number(hasList);',
    to: '    Number(hasFirst) + Number(hasLatest) + Number(hasCount) + 0;',
  },
  {
    name: "m3 알 수 없는 선수명 잔여를 전체 목록으로 오결속",
    file: EVENT,
    from: '  return residue.length === 0 ? query : null;',
    to: '  return query;',
  },
  {
    name: "m4 라우터 선결속 제거 — generic LLM 경로 회귀",
    file: PIPELINE,
    from: '  if (isNoHitNoRunQuestion(question)) return "event_record";',
    to: "",
  },
  {
    name: "m5 종단 null fail-close 제거 — 범위 밖 사건 렌더 시도",
    file: PIPELINE,
    from: '      if (!result) return settleEventRecord(resolveHoldAnswer(question), "history_hold");',
    to: "",
  },
  {
    name: "m6 원장 값 변조 — 최근 기록 점수 오답",
    file: DATA,
    from: '      "score": "16-0",',
    to: '      "score": "15-0",',
  },
];

let red = 0;
const bad = [];
for (const mutation of MUTATIONS) {
  const file = path.join(ROOT, mutation.file);
  const backup = `${file}.mutation-backup`;
  const before = readFileSync(file, "utf8");
  if (!before.includes(mutation.from)) {
    bad.push(`MISS ${mutation.name}`);
    console.log(`MISS ${mutation.name}`);
    continue;
  }
  copyFileSync(file, backup);
  try {
    writeFileSync(file, before.replace(mutation.from, mutation.to));
    let detected = false;
    let compileError = false;
    try {
      execFileSync("npx", ["tsx", SMOKE], { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      detected = /FAIL /.test(output);
      compileError = /error TS|SyntaxError|Cannot find|is not defined|Unexpected/.test(output) && !detected;
    }
    if (detected) { red += 1; console.log(`RED  ${mutation.name}`); }
    else if (compileError) { bad.push(`COMPILE ${mutation.name}`); console.log(`COMPILE ${mutation.name}`); }
    else { bad.push(`GREEN ${mutation.name}`); console.log(`GREEN ${mutation.name}`); }
  } finally {
    copyFileSync(backup, file);
    unlinkSync(backup);
  }
}
console.log(`\nmutations: ${red}/${MUTATIONS.length} RED`);
if (bad.length) { bad.forEach((item) => console.log(`  ${item}`)); process.exit(1); }
