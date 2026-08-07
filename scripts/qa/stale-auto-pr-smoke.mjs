/**
 * 과거 자동 roster PR 자동 close 선택 로직 스모크.
 *
 * 검증 대상은 *값*이 아니라 *불변식*이다:
 *   - 자동 브랜치 접두사로만 대상 제한(사람 PR·다른 자동 트랙 절대 미포함).
 *   - 현재 브랜치 제외(자기 자신 미close).
 *   - currentBranch 미상이면 아무것도 안 닫음(fail-safe).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTO_ROSTER_BRANCH_PREFIX,
  selectStaleAutoPrs,
} from "../ci/lib/stale-auto-pr.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../..");

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
}

const CUR = `${AUTO_ROSTER_BRANCH_PREFIX}20260807`;
const OLD1 = `${AUTO_ROSTER_BRANCH_PREFIX}20260806`;
const OLD2 = `${AUTO_ROSTER_BRANCH_PREFIX}20260805`;

console.log("§1 선택 규칙");

check("과거 자동 PR 만 고르고 현재 브랜치는 제외한다", () => {
  const open = [
    { number: 1, headRefName: CUR },
    { number: 2, headRefName: OLD1 },
    { number: 3, headRefName: OLD2 },
  ];
  const picked = selectStaleAutoPrs(open, CUR).map((p) => p.number).sort();
  assert.deepEqual(picked, [2, 3]);
});

// 없으면: 사람이 만든 PR 이나 다른 자동 트랙 PR 이 자동 close 된다(사고).
check("사람 PR·다른 자동 트랙은 절대 포함하지 않는다", () => {
  const open = [
    { number: 10, headRefName: OLD1 }, // 대상
    { number: 11, headRefName: "feat/some-feature" }, // 사람
    { number: 12, headRefName: "fix/bug-123" }, // 사람
    { number: 13, headRefName: "auto/update-photos-20260806" }, // 다른 자동 트랙
    { number: 14, headRefName: "auto/hero-shot-20260806" }, // 다른 자동 트랙
  ];
  const picked = selectStaleAutoPrs(open, CUR).map((p) => p.number);
  assert.deepEqual(picked, [10]);
});

// 없으면: currentBranch 를 못 넘겼을 때 방금 만든 PR 을 스스로 닫을 수 있다.
check("currentBranch 가 비면 아무것도 닫지 않는다 (fail-safe)", () => {
  const open = [
    { number: 20, headRefName: OLD1 },
    { number: 21, headRefName: OLD2 },
  ];
  assert.deepEqual(selectStaleAutoPrs(open, ""), []);
  assert.deepEqual(selectStaleAutoPrs(open, undefined), []);
});

// 없으면: 현재 브랜치와 이름이 같은 PR(자기 자신)이 close 대상에 든다.
check("현재 브랜치와 같은 PR 은 close 대상이 아니다", () => {
  const open = [{ number: 30, headRefName: CUR }];
  assert.deepEqual(selectStaleAutoPrs(open, CUR), []);
});

check("빈/비정상 입력은 빈 배열", () => {
  assert.deepEqual(selectStaleAutoPrs([], CUR), []);
  assert.deepEqual(selectStaleAutoPrs(null, CUR), []);
  assert.deepEqual(selectStaleAutoPrs([{ number: 1 }], CUR), []); // headRefName 없음
});

console.log("\n§2 프로덕션 배선 — 워크플로가 실제로 이 정리를 태우는가");

const wf = readFileSync(
  join(PROJECT_ROOT, ".github/workflows/update-roster-stats.yml"),
  "utf-8"
);

// 없으면: 스크립트는 있는데 워크플로가 안 불러 stale PR 이 계속 쌓인다.
check("워크플로가 close-stale-auto-roster-prs 를 현재 브랜치와 함께 호출한다", () => {
  assert.match(
    wf,
    /node scripts\/ci\/close-stale-auto-roster-prs\.mjs "\$BRANCH"/,
    "close 스크립트를 $BRANCH 인자와 함께 호출하지 않는다"
  );
});

// 없으면: 브랜치 접두사가 신규 생성 로직과 어긋나면 대상이 안 잡힌다.
check("워크플로 신규 브랜치 접두사가 close 대상 접두사와 일치한다", () => {
  assert.ok(
    wf.includes(`BRANCH="${AUTO_ROSTER_BRANCH_PREFIX}`),
    `워크플로 생성 브랜치 접두사가 ${AUTO_ROSTER_BRANCH_PREFIX} 와 다르다`
  );
});

if (failures.length) {
  console.error(`\n❌ FAIL ${failures.length}건`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nPASS=${pass} FAIL=0`);
console.log("✅ 과거 자동 roster PR 정리 스모크 통과");
