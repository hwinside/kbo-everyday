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
 *       그대로 import 해 전 케이스(0·1·9·10팀, 중복·비정규 slug) 판정.
 *   §2 배선 — TeamTagger 에 "전체 선택" 칩이 사라졌고, 3종 컴포저가 확인창 훅을
 *       import·호출(await)·렌더하며 "아니요"에서 최애팀으로 축소하는지, 잔존 onSetAll 이 없는지.
 *
 * 실행:  npm run qa:post-scope-all-teams-confirm            (정상 게이트 — prebuild 포함)
 * 자체검증: npm run qa:post-scope-all-teams-confirm:selftest  (결함 주입 → RED 검출 증명, prebuild 미포함)
 *   selftest 는 정상처럼 exit 0 으로 끝난다(모든 주입이 RED 로 잡히면 PASS). brand-icon-clip 등 기존 패턴 동일.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TEAMS } from "../../src/lib/constants/teams";
import { isAllTeamsSelected, hasRequiredTeamTag } from "../../src/lib/utils/post-scope";

const ROOT = resolve(__dirname, "../..");
const ALL = TEAMS.map((t) => t.slug);
const ONE = [ALL[0]];
const NINE = ALL.slice(0, ALL.length - 1);

// ── §1 규칙 SSOT (실제 함수 실행) ───────────────────────────────
function pureChecks(): string[] {
  const f: string[] = [];
  const eq = (label: string, cond: boolean) => {
    if (!cond) f.push(label);
  };
  eq("§1 0팀 → 등록 불가", hasRequiredTeamTag([]) === false);
  eq("§1 1팀 → 등록 가능", hasRequiredTeamTag(ONE) === true);
  eq("§1 10팀 → 등록 가능", hasRequiredTeamTag(ALL) === true);
  eq("§1 0팀 → 확인창 아님", isAllTeamsSelected([]) === false);
  eq("§1 1팀 → 확인창 아님", isAllTeamsSelected(ONE) === false);
  eq(`§1 9팀 → 확인창 아님`, isAllTeamsSelected(NINE) === false);
  eq("§1 10팀 전부 → 확인창", isAllTeamsSelected(ALL) === true);
  eq("§1 10팀 + 중복 → 확인창", isAllTeamsSelected([...ALL, ALL[0]]) === true);
  eq("§1 9팀 + 비정규 slug → 확인창 아님", isAllTeamsSelected([...NINE, "not-a-team"]) === false);
  eq("§1 전체 판정은 TEAMS 전량 기준(하드코딩 금지)", ALL.length === TEAMS.length && TEAMS.length >= 10);
  return f;
}

// ── §2 배선 (소스 구조; 결함 주입 가능하도록 sources 를 인자로) ────
type Sources = { tagger: string; writePost: string; writePhoto: string; writePoll: string };
function realSources(): Sources {
  const rd = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
  return {
    tagger: rd("src/components/community/TeamTagger.tsx"),
    writePost: rd("src/components/community/WritePost.tsx"),
    writePhoto: rd("src/components/community/WritePhotoPost.tsx"),
    writePoll: rd("src/components/community/WritePoll.tsx"),
  };
}
const COMPOSERS: Array<[keyof Sources, string, string]> = [
  ["writePost", "WritePost.tsx", "setTeamSlugs"],
  ["writePhoto", "WritePhotoPost.tsx", "setTeamSlugs"],
  ["writePoll", "WritePoll.tsx", "setTagTeamSlugs"],
];
function structuralChecks(s: Sources): string[] {
  const f: string[] = [];
  const eq = (label: string, cond: boolean) => {
    if (!cond) f.push(label);
  };
  eq("§2 TeamTagger '전체 선택' 칩 제거", !/data-team-select-all/.test(s.tagger));
  eq("§2 TeamTagger onSetAll prop 제거", !/onSetAll/.test(s.tagger));
  for (const [key, name, setter] of COMPOSERS) {
    const c = s[key];
    eq(`§2 ${name} 확인창 훅 import`, /useAllTeamsScopeConfirm/.test(c));
    eq(`§2 ${name} confirmAllTeamsScope await 호출`, /await\s+confirmAllTeamsScope\(\)/.test(c));
    eq(`§2 ${name} allTeamsScopeDialog 렌더`, /\{allTeamsScopeDialog\}/.test(c));
    eq(`§2 ${name} isAllTeamsSelected 사용`, /isAllTeamsSelected\(/.test(c));
    eq(`§2 ${name} 아니요→최애팀 축소`, new RegExp(`${setter}\\(\\[favoriteSlug\\]\\)`).test(c));
    eq(`§2 ${name} onSetAll 미사용`, !/onSetAll/.test(c));
  }
  return f;
}

// ── 정상 게이트 ─────────────────────────────────────────────────
function runGate(): number {
  const fails = [...pureChecks(), ...structuralChecks(realSources())];
  if (fails.length) {
    console.error(`[post-scope-all-teams-confirm] FAIL (${fails.length}):`);
    for (const x of fails) console.error("  - " + x);
    return 1;
  }
  console.log("[post-scope-all-teams-confirm] PASS — 규칙 SSOT + 3종 컴포저 확인창 배선 확인");
  return 0;
}

// ── 자체검증: 결함 주입 → RED 가 실제로 잡히는지(검출력 증명) ────
function runSelftest(): number {
  const base = realSources();
  const slipped: string[] = [];
  const expectRed = (label: string, mutate: (s: Sources) => Sources) => {
    const before = structuralChecks(base).length;
    const after = structuralChecks(mutate(base)).length;
    if (after <= before) slipped.push(label); // 주입 후 실패가 늘지 않으면 검출 실패.
  };

  // 구조 결함 주입 — 각 우회가 반드시 새 RED 를 만들어야 한다.
  expectRed("전체 선택 칩 재노출", (s) => ({ ...s, tagger: s.tagger + "\n<button data-team-select-all />" }));
  expectRed("TeamTagger onSetAll 재도입", (s) => ({ ...s, tagger: s.tagger + "\nonSetAll" }));
  for (const [key, name] of COMPOSERS) {
    expectRed(`${name} 확인창 호출 제거`, (s) => ({ ...s, [key]: s[key].replace(/await\s+confirmAllTeamsScope\(\)/g, "false") }));
    expectRed(`${name} 다이얼로그 렌더 제거`, (s) => ({ ...s, [key]: s[key].replace(/\{allTeamsScopeDialog\}/g, "") }));
    expectRed(`${name} onSetAll 재도입`, (s) => ({ ...s, [key]: s[key] + "\nonSetAll" }));
    expectRed(`${name} 최애팀 축소 제거`, (s) => ({ ...s, [key]: s[key].replace(/\(\[favoriteSlug\]\)/g, "([])") }));
  }

  // §1 규칙 anti-vacuous — 판정이 실제로 구분하는지.
  if (isAllTeamsSelected(ALL) === isAllTeamsSelected(NINE)) slipped.push("규칙: 10팀/9팀 판정 미구분");
  if (hasRequiredTeamTag([]) === hasRequiredTeamTag(ONE)) slipped.push("규칙: 0팀/1팀 판정 미구분");
  // 정상 소스는 게이트를 통과해야 한다(오검출 없음).
  const baseFails = structuralChecks(base).length + pureChecks().length;
  if (baseFails !== 0) slipped.push(`정상 소스 오검출 ${baseFails}건`);

  if (slipped.length) {
    console.error(`[post-scope-all-teams-confirm] SELFTEST FAIL — 검출 못한 결함 ${slipped.length}건:`);
    for (const x of slipped) console.error("  - " + x);
    return 1;
  }
  console.log("[post-scope-all-teams-confirm] SELFTEST PASS — 주입 결함 전량 RED 검출(검출력 증명)");
  return 0;
}

process.exit(process.argv.includes("--selftest") ? runSelftest() : runGate());
