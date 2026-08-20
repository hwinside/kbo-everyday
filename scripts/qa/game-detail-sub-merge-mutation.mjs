/**
 * mutation gate: 순수 대타/대주 수비 위치의 Naver 병합 배선이 실제로 검출되는지 증명.
 *
 * 삼순 NO-GO(P0, PR #1171 2차): helper 단위 테스트만으로는 route의
 * `KBO 순수 대/주 → 동일 deadline Naver 대기 → 응답 병합` 배선을 제거해도
 * GREEN(false-green). 여기서 배선/로직을 결함주입으로 죽여
 * game-detail-bounded-fallback-smoke(actual GET)가 RED가 되는지 고정한다.
 *
 * 검증력 규칙(2026-08-09 lessons): 아무 nonzero exit이나 RED로 세지 않는다.
 * 컴파일 오류·무관 실패를 배제하기 위해 실패 출력에 sub-merge 시나리오의
 * assertion 메시지가 실제로 등장해야만 RED로 인정한다.
 *
 * 복원은 백업 파일 복사로만 한다(git checkout -- 금지, P0).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PR #1257: game-detail GET 구현이 route → src/lib/services/game-detail.ts 로 물리 이동했다.
// route 는 얇은 래퍼가 됐으므로 병합 배선 mutation 의 대상 파일도 service 로 따라간다.
// (의미론 완화 아님 — 같은 배선을 같은 방식으로 죽이고, 판정은 여전히 route GET 을 태우는
//  game-detail-bounded-fallback-smoke 의 assertion marker 로만 인정한다.)
const SERVICE = "src/lib/services/game-detail.ts";
const HELPER = "src/lib/utils/sub-position-merge.ts";
const SMOKE = "scripts/qa/game-detail-bounded-fallback-smoke.ts";

const backupDir = mkdtempSync(join(tmpdir(), "sub-merge-mutation-"));
const backups = new Map();
for (const file of [SERVICE, HELPER]) {
  const backup = join(backupDir, file.replaceAll("/", "__"));
  copyFileSync(file, backup);
  backups.set(file, backup);
}

function restoreAll() {
  for (const [file, backup] of backups) copyFileSync(backup, file);
}

function runSmoke() {
  try {
    const stdout = execFileSync("npx", ["tsx", SMOKE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    };
  }
}

function mutate(file, from, to, label) {
  const source = readFileSync(file, "utf8");
  if (!source.includes(from)) {
    throw new Error(`${label}: mutation anchor not found in ${file}`);
  }
  writeFileSync(file, source.replace(from, to));
}

let failures = 0;

// baseline: 무결함 상태에서 GREEN이어야 mutation RED가 의미를 가진다.
{
  const { ok } = runSmoke();
  if (!ok) {
    console.error("❌ baseline이 GREEN이 아님 — mutation 판정 불가");
    restoreAll();
    rmSync(backupDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("✅ baseline GREEN");
}

const MUTATIONS = [
  {
    label: "M1 병합 배선 제거 (hasPureSubPositions 게이트 무력화)",
    file: SERVICE,
    from: "if (boxScore && boxScoreSource === \"kbo\" && hasPureSubPositions(boxScore)) {",
    to: "if (false && boxScore && boxScoreSource === \"kbo\" && hasPureSubPositions(boxScore)) {",
    marker: "route가 Naver 복합 위치(타중)로 병합",
  },
  {
    label: "M2 helper 병합 대입 제거 (mergeSide no-op)",
    file: HELPER,
    from: "    t.position = s.position;",
    to: "    // t.position = s.position;",
    marker: "route가 Naver 복합 위치(타중)로 병합",
  },
  {
    label: "M3 감지 함수 무력화 (hasPureSubPositions always false)",
    file: HELPER,
    from: "  return batters.awayBatters.some(isPure) || batters.homeBatters.some(isPure);",
    to: "  return false;",
    marker: "route가 Naver 복합 위치(타중)로 병합",
  },
];

for (const { label, file, from, to, marker } of MUTATIONS) {
  restoreAll();
  try {
    mutate(file, from, to, label);
    const { ok, output } = runSmoke();
    if (ok) {
      console.error(`❌ ${label}: 결함 주입에도 GREEN (검출 실패)`);
      failures++;
    } else if (!output.includes(marker)) {
      console.error(`❌ ${label}: RED이지만 sub-merge assertion이 아닌 다른 원인 (false RED 의심)`);
      console.error(output.split("\n").slice(-15).join("\n"));
      failures++;
    } else {
      console.log(`RED ${label}`);
    }
  } finally {
    restoreAll();
  }
}

// 복원 검증: 원본과 byte 동일해야 종료.
for (const [file, backup] of backups) {
  if (readFileSync(file, "utf8") !== readFileSync(backup, "utf8")) {
    console.error(`❌ 복원 실패: ${file}`);
    failures++;
  }
}
rmSync(backupDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n❌ game-detail-sub-merge mutation: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\n✅ game-detail-sub-merge mutation PASS (3종 전부 RED)");
