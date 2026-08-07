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

/** GITHUB_TOKEN 이 만든 PR 의 저자 login — exact allowlist(유사 이름 bot 차단). */
export const ACTIONS_BOT_LOGINS = new Set(["github-actions[bot]", "app/github-actions"]);

/** Actions bot 저자 판별 — is_bot 이며 login 이 exact allowlist 에 있어야 한다.
 * ⚠︎ 삼순 NO-GO(축③-2): `/github-actions/` 부분일치는 `evil-github-actions-x` 같은 유사
 * 이름 bot 도 통과시켜 fail-open 이다 → exact 문자열 allowlist 로 잠근다. */
export function isActionsBotAuthor(author) {
  if (!author || author.is_bot !== true) return false;
  return ACTIONS_BOT_LOGINS.has(author.login);
}

/**
 * 열린 PR 목록에서 close 대상(현재보다 **엄격히 더 오래된** 자동 roster PR)을 고른다.
 *
 * ⚠︎ 삼순 CODE NO-GO(축③): 종전 판은 "현재 브랜치 외 모든 prefix PR" 을 닫아,
 * 겹친 두 런 A/B 가 각자 PR 을 만든 뒤 **서로 상대의 신규 PR 을 닫는 경합**이 열렸다.
 * 그래서 (a) workflow concurrency 직렬화 + (b) 여기서 current PR 의 createdAt 보다
 * 엄격히 더 오래된 것만 닫도록 이중 잠근다. current PR/시각 확인 불가면 no-op.
 *
 * 규칙(전부 만족해야 close):
 *   - head 브랜치가 `auto/update-roster-stats-` 접두사.
 *   - current PR 과 번호가 다름(자기 자신 제외).
 *   - createdAt 이 current PR 보다 **엄격히 과거**(created < currentCreated).
 *   - 저자가 Actions bot(사람 PR 미포함 계약 강화).
 *   - same-repo(cross-repo fork PR 제외).
 *   - current PR 이 없거나 그 createdAt 을 못 읽으면 전체 no-op.
 *
 * @param {Array<{number:number, headRefName:string, createdAt:string, author?:object, isCrossRepository?:boolean}>} openPrs
 * @param {{number:number, createdAt:string}|null|undefined} currentPr 방금 만든 자동 PR.
 * @returns {Array} close 할 PR 들.
 */
export function selectStaleAutoPrs(openPrs, currentPr) {
  if (!Array.isArray(openPrs)) return [];
  // current PR/시각 확인 불가 → 안전하게 아무것도 안 닫는다.
  if (!currentPr || typeof currentPr.number !== "number") return [];
  const currentCreated = Date.parse(currentPr.createdAt);
  if (!Number.isFinite(currentCreated)) return [];

  return openPrs.filter((pr) => {
    if (!pr || typeof pr.number !== "number") return false;
    const branch = pr.headRefName;
    if (typeof branch !== "string" || !branch.startsWith(AUTO_ROSTER_BRANCH_PREFIX)) return false;
    if (pr.number === currentPr.number) return false; // 자기 자신(번호 기준)
    // ⚠︎ 삼순 NO-GO(축③-2): `!== true` 만 제외하면 isCrossRepository 누락(undefined)이 통과한다
    // (fail-open). same-repo 를 **긍정 확인**(=== false)해야 fork/미상 모두 차단된다.
    if (pr.isCrossRepository !== false) return false; // same-repo 긍정 확인만
    if (!isActionsBotAuthor(pr.author)) return false; // Actions bot 저자만(exact allowlist)
    const created = Date.parse(pr.createdAt);
    if (!Number.isFinite(created)) return false; // 시각 못 읽으면 제외
    if (!(created < currentCreated)) return false; // 엄격히 더 오래된 것만
    return true;
  });
}
