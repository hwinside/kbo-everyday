/**
 * stats-2025 integrity 게이트의 **검출력 결함주입 스위트** — 커밋/CI 결속본.
 *
 * 삼순 #1206 NO-GO 필수 2: "보고한 mutation 이 exact 에 커밋되지 않았다" →
 * 일회성 셸이 아니라 이 스크립트가 prebuild 에 물려 모든 PR 에서 돈다.
 *
 * 방식: 데이터/게이트 파일을 백업 → 변조 주입 → 게이트 실행(반드시 exit≠0) → 복원.
 * 하나라도 GREEN(미검출)이면 이 스위트가 exit 1 로 빌드를 죽인다.
 *
 * 변조 축 (삼순 지정 3종 포함):
 *  M1 Basic1행→Basic2 주입: bb=games·ibb=pa·hbp=ab·so=runs·gdp=hits·slg=2B·obp=3B·ops=HR
 *     (76e623ef8 오염의 정확한 재현)
 *  M2 BB↔HBP swap (PA 항등식·IBB≤BB 를 모두 통과하는 교환 — snapshot-hash 가 잡아야 함)
 *  M3 GDP 단독 +1
 *  M4 SO 단독 +1
 *  M5 행 삭제 (42→41)
 *  M6 비율 정수화 (obp="1")
 *  M7 투수 era 정수화
 *  S1 크롤러 header 검증 anchor 결속 (assertTableHeader 호출이 Basic1/Basic2/Runner 에 존재)
 *  S2 게이트 snapshot-hash 축 제거 시 M2/M3 가 실제로 뚫리는지 (해시 축의 존재 증명)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BATTERS = path.join(root, "src/lib/constants/stats-2025-batters.json");
const PITCHERS = path.join(root, "src/lib/constants/stats-2025-pitchers.json");
const GATE = path.join(root, "scripts/qa/stats-2025-integrity-smoke.ts");
const CRAWLER = path.join(root, "scripts/crawl-stats.mjs");

let fail = 0;
const results = [];

function gatePasses() {
  try {
    execFileSync("node_modules/.bin/tsx", [GATE], { cwd: root, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function withMutatedJson(file, mutate, label) {
  const backup = `${file}.mutbak`;
  copyFileSync(file, backup);
  try {
    const rows = JSON.parse(readFileSync(file, "utf8"));
    mutate(rows);
    writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
    const green = gatePasses();
    results.push({ label, red: !green });
    if (green) fail += 1;
  } finally {
    copyFileSync(backup, file);
    execFileSync("rm", [backup]);
  }
}

// M1 — Basic1행→Basic2 주입 (밀림 재현)
withMutatedJson(BATTERS, (rows) => {
  for (const r of rows) {
    r.bb = r.games; r.ibb = r.pa; r.hbp = r.ab; r.so = r.runs; r.gdp = r.hits;
    r.slg = String(r.doubles); r.obp = String(r.triples); r.ops = String(r.hr);
  }
}, "M1 Basic1행→Basic2 주입 (76e623ef8 밀림 재현)");

// M2 — BB↔HBP swap (항등식 통과형 교환)
withMutatedJson(BATTERS, (rows) => {
  const r = rows[0];
  [r.bb, r.hbp] = [r.hbp, r.bb];
}, "M2 BB↔HBP swap (항등식 통과형)");

// M3 — GDP 단독 +1
withMutatedJson(BATTERS, (rows) => { rows[0].gdp += 1; }, "M3 GDP 단독 +1");

// M4 — SO 단독 +1
withMutatedJson(BATTERS, (rows) => { rows[0].so += 1; }, "M4 SO 단독 +1");

// M5 — 행 삭제
withMutatedJson(BATTERS, (rows) => { rows.pop(); }, "M5 행 삭제 (42→41)");

// M6 — 비율 정수화
withMutatedJson(BATTERS, (rows) => { rows[0].obp = "1"; }, "M6 비율 정수화 (obp=\"1\")");

// M7 — 투수 era 정수화
withMutatedJson(PITCHERS, (rows) => { rows[0].era = "3"; }, "M7 투수 era 정수화");

// S1 — 크롤러 header 검증 anchor 결속 (구조 검사: 제거되면 여기서 즉시 RED)
{
  const src = readFileSync(CRAWLER, "utf8");
  const anchors = [
    /await assertTableHeader\(page, "타자 Basic1", HEADER_BATTER_BASIC1\)/,
    /await assertTableHeader\(page, "타자 Basic2", HEADER_BATTER_BASIC2\)/,
    /await assertTableHeader\(page, "도루 Runner", HEADER_RUNNER\)/,
    /header drift — 크롤 중단/,
  ];
  const missing = anchors.filter((a) => !a.test(src));
  const red = missing.length === 0;
  results.push({ label: "S1 크롤러 header fail-close 결속 (Basic1·Basic2·Runner)", red });
  if (!red) fail += 1;
}

// S2 — 게이트에서 snapshot-hash 축을 제거하면 M2(swap)가 실제로 뚫린다 = 해시 축이 검출을 담당한다는 증명
{
  const backup = `${GATE}.mutbak`;
  const dataBackup = `${BATTERS}.mutbak2`;
  copyFileSync(GATE, backup);
  copyFileSync(BATTERS, dataBackup);
  try {
    const src = readFileSync(GATE, "utf8");
    const neutered = src.replace(/for \(const \[path, expected\] of Object\.entries\(SNAPSHOT_SHA256\)\) \{[\s\S]*?\n\}\n/, "");
    if (neutered === src) {
      results.push({ label: "S2 snapshot-hash 축 존재 증명", red: false, note: "anchor miss" });
      fail += 1;
    } else {
      writeFileSync(GATE, neutered);
      const rows = JSON.parse(readFileSync(BATTERS, "utf8"));
      [rows[0].bb, rows[0].hbp] = [rows[0].hbp, rows[0].bb];
      writeFileSync(BATTERS, `${JSON.stringify(rows, null, 2)}\n`);
      // 해시 축이 빠지면 swap 이 GREEN 이어야 정상(= 해시가 유일한 검출자였다는 증명).
      const greenWithoutHash = gatePasses();
      results.push({ label: "S2 snapshot-hash 축이 swap 검출을 담당함을 증명 (해시 제거 시 GREEN)", red: greenWithoutHash });
      if (!greenWithoutHash) fail += 1;
    }
  } finally {
    copyFileSync(backup, GATE);
    copyFileSync(dataBackup, BATTERS);
    execFileSync("rm", [backup, dataBackup]);
  }
}

for (const r of results) {
  console.log(`${r.red ? "✅" : "❌"} ${r.label}: ${r.red ? "RED" : "GREEN (미검출)"}${r.note ? ` [${r.note}]` : ""}`);
}
if (fail > 0) {
  console.error(`\n❌ stats-2025 integrity mutations: ${fail}건 미검출`);
  process.exit(1);
}
console.log(`\n✅ stats-2025 integrity mutations: ${results.length}/${results.length} RED`);
