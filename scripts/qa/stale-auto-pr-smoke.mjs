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
  isActionsBotAuthor,
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

const CUR_BRANCH = `${AUTO_ROSTER_BRANCH_PREFIX}20260807`;
const OLD1 = `${AUTO_ROSTER_BRANCH_PREFIX}20260806`;
const OLD2 = `${AUTO_ROSTER_BRANCH_PREFIX}20260805`;
const BOT = { login: "github-actions[bot]", is_bot: true };
const T = (iso) => iso; // 가독성용

// 기본형 PR: Actions bot · same-repo · auto 접두사. 각 테스트는 깨뜨릴 축 하나만 바꿜다.
const pr = (over = {}) => ({
  number: 2,
  headRefName: OLD1,
  createdAt: "2026-08-06T20:00:00Z",
  author: BOT,
  isCrossRepository: false,
  ...over,
});
// current PR(방금 만든 것) — 가장 최근.
const CUR = { number: 1, headRefName: CUR_BRANCH, createdAt: "2026-08-07T20:00:00Z", author: BOT, isCrossRepository: false };

console.log("§1 선택 규칙");

check("현재보다 엄격히 오래된 자동 PR 만 고른다", () => {
  const open = [
    CUR,
    pr({ number: 2, headRefName: OLD1, createdAt: "2026-08-06T20:00:00Z" }),
    pr({ number: 3, headRefName: OLD2, createdAt: "2026-08-05T20:00:00Z" }),
  ];
  const picked = selectStaleAutoPrs(open, CUR).map((p) => p.number).sort();
  assert.deepEqual(picked, [2, 3]);
});

// 삼순 NO-GO 핵심: current 보다 더 새로운(미래) auto PR 은 절대 닫지 않는다(겹친 런 경합 차단).
check("current 보다 새로운 auto PR 은 닫지 않는다(엄격히 과거만)", () => {
  const newer = pr({ number: 9, headRefName: `${AUTO_ROSTER_BRANCH_PREFIX}20260808`, createdAt: "2026-08-08T20:00:00Z" });
  const older = pr({ number: 2, createdAt: "2026-08-06T20:00:00Z" });
  const picked = selectStaleAutoPrs([CUR, newer, older], CUR).map((p) => p.number);
  assert.deepEqual(picked, [2]);
});
check("createdAt 가 current 와 동일하면 닫지 않는다(엄격 부등호)", () => {
  const tie = pr({ number: 5, createdAt: CUR.createdAt });
  assert.deepEqual(selectStaleAutoPrs([CUR, tie], CUR), []);
});

// 없으면: 사람 PR 이나 다른 자동 트랙 PR 이 자동 close 된다(사고).
check("사람 PR·다른 자동 트랙은 절대 포함하지 않는다", () => {
  const open = [
    CUR,
    pr({ number: 10, headRefName: OLD1 }), // 대상
    pr({ number: 11, headRefName: "feat/some-feature" }), // 사람(접두사 불일치)
    pr({ number: 13, headRefName: "auto/update-photos-20260806" }), // 다른 자동 트랙
  ];
  const picked = selectStaleAutoPrs(open, CUR).map((p) => p.number);
  assert.deepEqual(picked, [10]);
});

// 삼순: prefix 만으로 부족 — Actions bot author 도 확인.
check("auto 접두사라도 사람/비-bot 저자면 닫지 않는다", () => {
  const humanAuto = pr({ number: 40, headRefName: OLD1, author: { login: "harinclaw", is_bot: false } });
  assert.deepEqual(selectStaleAutoPrs([CUR, humanAuto], CUR), []);
});

// 삼순: same-repo 확인 — cross-repo fork PR 제외.
check("cross-repo fork PR 은 닫지 않는다(same-repo only)", () => {
  const fork = pr({ number: 50, headRefName: OLD1, isCrossRepository: true });
  assert.deepEqual(selectStaleAutoPrs([CUR, fork], CUR), []);
});

// 없으면: current PR 을 못 찾거나 시각 못 읽을 때 방금 만든 PR 을 스스로 닫을 수 있다.
check("current PR/시각 확인 불가면 no-op", () => {
  const open = [pr({ number: 20 }), pr({ number: 21, headRefName: OLD2, createdAt: "2026-08-05T20:00:00Z" })];
  assert.deepEqual(selectStaleAutoPrs(open, null), []);
  assert.deepEqual(selectStaleAutoPrs(open, undefined), []);
  assert.deepEqual(selectStaleAutoPrs(open, { number: 1, createdAt: "not-a-date" }), []);
  assert.deepEqual(selectStaleAutoPrs(open, { createdAt: CUR.createdAt }), []); // number 없음
});

check("빈/비정상 입력은 빈 배열", () => {
  assert.deepEqual(selectStaleAutoPrs([], CUR), []);
  assert.deepEqual(selectStaleAutoPrs(null, CUR), []);
  assert.deepEqual(selectStaleAutoPrs([pr({ number: 1, headRefName: undefined })], CUR), []);
});

check("isActionsBotAuthor 판별", () => {
  assert.equal(isActionsBotAuthor({ login: "github-actions[bot]", is_bot: true }), true);
  assert.equal(isActionsBotAuthor({ login: "app/github-actions", is_bot: true }), true);
  assert.equal(isActionsBotAuthor({ login: "harinclaw", is_bot: false }), false);
  assert.equal(isActionsBotAuthor({ login: "some-bot", is_bot: true }), false); // github-actions 아니면 제외
  assert.equal(isActionsBotAuthor(null), false);
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

// 없으면: 겹친 두 런이 동시 실행돼 PR 경합이 다시 열린다(삼순 NO-GO 핵심).
check("워크플로가 concurrency 로 직렬화된다(cancel-in-progress:false)", () => {
  assert.match(wf, /concurrency:\s*\n\s*group:\s*update-roster-stats/, "concurrency group 가 없다");
  // ⚠︎ 주석이 아니라 **실제 YAML 키 라인**만 매칭한다. 주석에도 "cancel-in-progress:false"가
  // 있어 느슨한 정규식은 cancel-in-progress:true 로 바꿔도 주석을 잡아 GREEN 이 된다(자체발견).
  assert.match(wf, /^\s*cancel-in-progress: false\s*$/m, "cancel-in-progress: false 설정 라인이 없다(진행 런을 죽이면 안 된다)");
});

// 없으면: createdAt/author/isCrossRepository 를 안 뽑아 이중잠금 가드가 무용지물이 된다.
check("close 스크립트가 createdAt·author·isCrossRepository 를 조회하고 current PR 을 해석한다", () => {
  const closeSrc = readFileSync(join(PROJECT_ROOT, "scripts/ci/close-stale-auto-roster-prs.mjs"), "utf-8");
  assert.match(closeSrc, /number,headRefName,createdAt,author,isCrossRepository/, "이중잠금용 필드를 조회하지 않는다");
  assert.match(closeSrc, /find\(\(p\) => p\?\.headRefName === currentBranch\)/, "current PR 을 브랜치로 해석하지 않는다");
});

if (failures.length) {
  console.error(`\n❌ FAIL ${failures.length}건`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nPASS=${pass} FAIL=0`);
console.log("✅ 과거 자동 roster PR 정리 스모크 통과");
