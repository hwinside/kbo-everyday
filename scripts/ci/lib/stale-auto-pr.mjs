/**
 * 자동 roster/stats PR 정리 — 어떤 열린 자동 PR 을 close 할지 결정하는 순수 함수.
 *
 * 배경: `update-roster-stats.yml` 은 매일 `auto/update-roster-stats-YYYYMMDD` 브랜치로
 * 새 PR 을 연다. 자동 머지 게이트(roster 범위 보류 등)에 걸려 머지되지 못한 어제치 PR 은
 * open 으로 남고, 다음 날 또 새 PR 이 열려 stale 자동 PR 이 계속 누적됐다
 * (#1095·#1086·#1059·#893·#699). 신규 PR 을 열 때 과거 자동 PR 을 자동 close 한다.
 *
 * 순수 함수로 분리한 이유: gh CLI 셸 로직 안에 두면 게이트가 "무엇을 close 하는가"를
 * 문자열로만 볼 수 있어 행동 검증이 안 된다. 선택 규칙 자체를 함수로 뽑아 직접 호출해
 * 검증한다.
 */

/** 자동 roster/stats PR 의 브랜치 접두사 — 신규 생성 로직과 반드시 일치해야 한다. */
export const AUTO_ROSTER_BRANCH_PREFIX = "auto/update-roster-stats-";

/**
 * 열린 PR 목록에서 close 대상(과거 자동 roster PR)을 고른다.
 *
 * 규칙:
 *   - head 브랜치가 `auto/update-roster-stats-` 로 시작하는 자동 PR 만 대상.
 *   - 방금 만든 현재 브랜치(currentBranch)는 제외 — 자기 자신을 닫지 않는다.
 *   - 그 외(사람이 만든 브랜치, 다른 자동 트랙)는 절대 건드리지 않는다.
 *
 * @param {Array<{number:number, headRefName:string}>} openPrs `gh pr list --state open` 산출물.
 * @param {string} currentBranch 방금 생성한 자동 PR 의 브랜치.
 * @returns {Array<{number:number, headRefName:string}>} close 할 PR 들.
 */
export function selectStaleAutoPrs(openPrs, currentBranch) {
  if (!Array.isArray(openPrs)) return [];
  return openPrs.filter((pr) => {
    const branch = pr?.headRefName;
    if (typeof branch !== "string") return false;
    if (!branch.startsWith(AUTO_ROSTER_BRANCH_PREFIX)) return false;
    // 현재 브랜치는 제외 — currentBranch 가 비어 있으면(정체 불명) 안전하게 아무것도 안 닫는다.
    if (!currentBranch) return false;
    if (branch === currentBranch) return false;
    return true;
  });
}
