#!/usr/bin/env node
/**
 * 신규 자동 roster/stats PR 을 연 뒤, 과거에 열린 채 남은 자동 PR 을 close 한다.
 *
 * update-roster-stats.yml 의 Create PR 스텝 직후에 호출한다:
 *   node scripts/ci/close-stale-auto-roster-prs.mjs "<현재_브랜치>"
 *
 * gh CLI 를 사용하며 GH_TOKEN 이 필요하다. 선택 규칙은 순수 함수(selectStaleAutoPrs)가
 * 담당하고, 이 파일은 조회/닫기 I/O 만 한다. 어떤 PR 도 실수로 닫지 않도록 close 대상은
 * 반드시 자동 브랜치 접두사로 제한하고 현재 브랜치는 제외한다.
 */
import { execFileSync } from "node:child_process";
import { selectStaleAutoPrs } from "./lib/stale-auto-pr.mjs";

const currentBranch = process.argv[2] || "";
if (!currentBranch) {
  // 현재 브랜치를 모르면 아무것도 닫지 않는다(fail-safe) — 자기 자신을 닫을 위험 차단.
  console.error("현재 브랜치 인자가 없어 stale 자동 PR 정리를 건너뛴다.");
  process.exit(0);
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf-8" });
}

let openPrs = [];
try {
  const raw = gh([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,headRefName",
  ]);
  openPrs = JSON.parse(raw);
} catch (e) {
  console.error(`열린 PR 조회 실패 — 정리 건너뜀: ${e.message}`);
  process.exit(0); // 조회 실패는 신규 PR 흐름을 막지 않는다(best-effort 정리).
}

const stale = selectStaleAutoPrs(openPrs, currentBranch);
if (stale.length === 0) {
  console.log("정리할 과거 자동 roster PR 없음.");
  process.exit(0);
}

console.log(`과거 자동 roster PR ${stale.length}건 close 시도 (현재 브랜치 ${currentBranch} 제외):`);
let closed = 0;
let failed = 0;
for (const pr of stale) {
  try {
    gh([
      "pr",
      "close",
      String(pr.number),
      "--comment",
      `더 최신 자동 업데이트 PR 로 대체되어 자동 close 합니다 (브랜치 ${currentBranch}).`,
      "--delete-branch",
    ]);
    console.log(`  ✓ #${pr.number} (${pr.headRefName}) close`);
    closed++;
  } catch (e) {
    console.error(`  ✗ #${pr.number} (${pr.headRefName}) close 실패: ${e.message}`);
    failed++;
  }
}
console.log(`정리 완료 — close ${closed}건, 실패 ${failed}건.`);
// 정리 실패는 신규 PR 흐름을 막지 않는다(best-effort). 신규 PR 은 이미 만들어졌다.
process.exit(0);
