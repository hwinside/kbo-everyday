/**
 * 전체구단 공개 확인창 게이트 (하린아빠 2026-08-16 / 삼순 확정).
 *
 * 스펙:
 *   · 팀 태그 0개        → 등록 불가 (hasRequiredTeamTag=false)
 *   · 팀 태그 1~9개      → 선택 범위로 바로 등록 (확인창 없음)
 *   · 팀 태그 10개 전부  → 확인창 → 예: 전체공개 등록 / 아니요: 초안 유지 + 최애팀 1개 축소
 *   · 판정은 규칙 기반(내용 AI 판정 아님), 작성 3종(일반·사진·투표) 공통.
 *   · "전체 선택" 단축 칩 제거 — 전체공개는 10구단 개별 선택으로만.
 *
 * 검증 축:
 *   §1 규칙 SSOT — 컴포저가 실제 import 하는 isAllTeamsSelected / hasRequiredTeamTag 를
 *       그대로 import 해 전 케이스(0·1·9·10팀, 중복·비정규 slug 포함) 판정.
 *   §2 배선 — TeamTagger 에 "전체 선택" 칩이 사라졌고, 3종 컴포저가 확인창 훅을
 *       import·호출·렌더하며 "아니요"에서 최애팀으로 축소하는지, 잔존 onSetAll 이 없는지.
 *
 * 실행:  npm run qa:post-scope-all-teams-confirm
 * 자체검증: npm run qa:post-scope-all-teams-confirm:selftest  (기대 반전으로 RED 확인)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TEAMS } from "../../src/lib/constants/teams";
import { isAllTeamsSelected, hasRequiredTeamTag } from "../../src/lib/utils/post-scope";

const SELFTEST = process.argv.includes("--selftest");
const ROOT = resolve(__dirname, "../..");
const fails: string[] = [];
function check(label: string, cond: boolean) {
  // selftest 는 기대를 반전시켜, 게이트가 실제로 RED 를 낼 수 있음을 증명한다.
  const ok = SELFTEST ? !cond : cond;
  if (!ok) fails.push(label);
}

const ALL = TEAMS.map((t) => t.slug);
const ONE = [ALL[0]];
const NINE = ALL.slice(0, ALL.length - 1);

// ── §1 규칙 SSOT (실제 함수 실행) ────────────────────────────────
check("§1 0팀 → 등록 불가(hasRequiredTeamTag=false)", hasRequiredTeamTag([]) === false);
check("§1 1팀 → 등록 가능", hasRequiredTeamTag(ONE) === true);
check("§1 10팀 → 등록 가능", hasRequiredTeamTag(ALL) === true);
check("§1 0팀 → 확인창 아님", isAllTeamsSelected([]) === false);
check("§1 1팀 → 확인창 아님", isAllTeamsSelected(ONE) === false);
check(`§1 9팀(${NINE.length}) → 확인창 아님`, isAllTeamsSelected(NINE) === false);
check("§1 10팀 전부 → 확인창", isAllTeamsSelected(ALL) === true);
// 중복/비정규 slug 섞여도 10팀 집합이 채워지면 전체구단.
check("§1 10팀 + 중복 → 확인창", isAllTeamsSelected([...ALL, ALL[0]]) === true);
check("§1 9팀 + 비정규 slug → 확인창 아님", isAllTeamsSelected([...NINE, "not-a-team"]) === false);
// 팀 수가 늘어도 TEAMS 파생이라 자동 추종해야 한다(하드코딩 금지 신호).
check("§1 전체 판정은 TEAMS 전량 기준", ALL.length === TEAMS.length && TEAMS.length >= 10);

// ── §2 배선 (소스 구조) ──────────────────────────────────────────
function src(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}
const tagger = src("src/components/community/TeamTagger.tsx");
check("§2 TeamTagger '전체 선택' 칩 렌더 제거", !/data-team-select-all/.test(tagger) && !/onClick=\{\(\)\s*=>\s*onSetAll/.test(tagger));
check("§2 TeamTagger onSetAll prop 제거", !/onSetAll/.test(tagger));

const composers = [
  ["src/components/community/WritePost.tsx", "setTeamSlugs"],
  ["src/components/community/WritePhotoPost.tsx", "setTeamSlugs"],
  ["src/components/community/WritePoll.tsx", "setTagTeamSlugs"],
] as const;

for (const [rel, setter] of composers) {
  const s = src(rel);
  const name = rel.split("/").pop();
  // 확인창 훅 import + 호출 + 렌더.
  check(`§2 ${name} 확인창 훅 import`, /useAllTeamsScopeConfirm/.test(s));
  check(`§2 ${name} confirmAllTeamsScope 호출(await)`, /await\s+confirmAllTeamsScope\(\)/.test(s));
  check(`§2 ${name} allTeamsScopeDialog 렌더`, /\{allTeamsScopeDialog\}/.test(s));
  // 규칙 SSOT 사용(확인창 트리거).
  check(`§2 ${name} isAllTeamsSelected 사용`, /isAllTeamsSelected\(/.test(s));
  // "아니요" → 최애팀 1개로 축소.
  check(`§2 ${name} 아니요→최애팀 축소`, new RegExp(`${setter}\\(\\[favoriteSlug\\]\\)`).test(s));
  // 잔존 onSetAll 금지("전체 선택" 우회).
  check(`§2 ${name} onSetAll 미사용`, !/onSetAll/.test(s));
}

// ── 결과 ────────────────────────────────────────────────────────
if (fails.length) {
  console.error(`[post-scope-all-teams-confirm] ${SELFTEST ? "SELFTEST " : ""}FAIL (${fails.length}):`);
  for (const f of fails) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `[post-scope-all-teams-confirm] ${SELFTEST ? "SELFTEST(반전) " : ""}PASS — 규칙 SSOT + 3종 컴포저 확인창 배선 확인`,
);
