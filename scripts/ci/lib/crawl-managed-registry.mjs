/**
 * 크롤 자동 갱신 데이터 파일 레지스트리 (SSOT).
 *
 * 순환참조 메타게이트(축②)의 근간. 아래 파일들은 매일 크롤(scripts/crawl-roster-v2.mjs,
 * scripts/crawl-stats.mjs)이 write 하는 "움직이는 데이터"다. QA/게이트가 이 파일의 *값*을
 * 기대값으로 하드코딩해 비교하면, 크롤이 그 값을 갱신하는 순간 게이트가 RED 가 되어
 * roster/stats 자동 업데이트 PR 이 머지되지 못한다(#1059·#1086 곽빈 ERA 2.64 사고).
 *
 * ⚠️ 이 목록은 크롤러가 실제 write 하는 경로와 일치해야 한다. 크롤러가 새 산출물 파일을
 * 추가하면 여기에도 추가한다(스모크 §registry-sync 가 크롤러 소스와 대조해 강제한다).
 */

/** repo 루트 기준 상대 경로. 크롤이 매일 갱신하는 데이터 파일. */
export const CRAWL_MANAGED_FILES = Object.freeze([
  "src/lib/constants/players-roster.json",
  "src/lib/constants/stats-2026-batters.json",
  "src/lib/constants/stats-2026-pitchers.json",
  "src/lib/constants/stats-2026-defense.json",
  "src/lib/constants/player-defense-runs.json",
  "src/lib/constants/stats-2026-meta.json",
]);

/** 경로 문자열(어떤 형태로든)이 관리 파일을 가리키면 그 basename 을 돌려준다. 아니면 null. */
export function matchManagedFile(pathLike) {
  if (typeof pathLike !== "string" || pathLike.length === 0) return null;
  // 슬래시 정규화 후 basename 비교 — join(CONSTANTS,"x.json") / "src/lib/constants/x.json"
  // / import "...x.json" 등 표기 차이를 흡수한다.
  const norm = pathLike.replace(/\\/g, "/");
  for (const managed of CRAWL_MANAGED_FILES) {
    const base = managed.slice(managed.lastIndexOf("/") + 1);
    // basename 이 경로 세그먼트 경계로 등장해야 매치(부분문자열 오탐 방지).
    if (norm === managed || norm.endsWith("/" + base) || norm === base) return base;
  }
  return null;
}

/** 애노테이션 모드. structural = 구조/불변식만(값 하드코딩 금지). fixture = 관리파일 대신 합성 fixture 로직검증. */
export const MANAGED_READ_MODES = Object.freeze(["structural", "fixture"]);

/** 파일 상단 주석에서 `@crawl-managed-read: <mode>` 를 파싱. 없으면 null, 잘못된 mode 는 {mode:null,raw}. */
export function parseManagedReadAnnotation(source) {
  const m = /@crawl-managed-read:\s*([a-z-]+)/.exec(source);
  if (!m) return null;
  const mode = m[1];
  return { mode: MANAGED_READ_MODES.includes(mode) ? mode : null, raw: mode };
}
