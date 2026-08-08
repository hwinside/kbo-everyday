/**
 * 콜렉터(짤/움짤) 글의 작성자 팀 배지 게이트.
 *
 * 사고: 2026-08-07 하린아빠 — KIA 김도영 글(짤콜렉터)의 작성자 배지가 "LG 팬"으로 표시됐다.
 * 원인은 봇 프로필의 `profiles.team_id`(seed 임의값 1=LG)를 `author_team_id_snapshot`으로
 * 그대로 기록한 것. 봇은 응원팀이 없으므로 스냅샷은 **콘텐츠 팀**(매칭 board)에서 파생해야 한다.
 *
 * 이 게이트는 세 가지를 검증한다.
 *   ① resolveCollectorTeam 의 파생 행동(board → 팀) — 실제 로스터/구단 SSOT로.
 *   ② publisher 가 그 파생값을 team_tags 와 author_team_id_snapshot **양쪽**에 쓰고,
 *      봇 프로필 team_id 를 스냅샷 소스로 읽지 않는다(배선 결속).
 *   ③ 렌더 계약: CommunityAuthorHeader 가 그 스냅샷을 그대로 배지로 쓴다.
 *
 * Usage: npx tsx scripts/qa/collector-author-team-smoke.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCollectorTeam } from "@/lib/gif-collector/collector-team";
import { getTeamById, getTeamBySlug } from "@/lib/constants/teams";
import playersRoster from "@/lib/constants/players-roster.json";

const ROOT = process.cwd();
let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// ① resolveCollectorTeam — 실제 SSOT 기반 행동 검증
// ─────────────────────────────────────────────────────────────────────────────

interface RosterRow {
  name: string;
  kboId: string;
  teamId: number;
}
const roster = playersRoster as RosterRow[];

// 사고 재현 케이스: 김도영(52605) = KIA. LG 로 나오면 RED.
{
  const kimDoyoung = roster.find((p) => p.kboId === "52605");
  check("로스터에 김도영(52605) 존재", !!kimDoyoung, "로스터 SSOT 변경 시 케이스 갱신 필요");
  if (kimDoyoung) {
    const r = resolveCollectorTeam("player", "52605");
    const kia = getTeamById(kimDoyoung.teamId);
    check(
      "사고 재현: player/52605(김도영) → KIA (봇 프로필 LG 아님)",
      r?.id === kimDoyoung.teamId && r?.slug === kia?.slug,
      `got ${JSON.stringify(r)}, want id=${kimDoyoung.teamId} slug=${kia?.slug}`,
    );
    check("사고 재현: 결과가 LG(1)가 아니다", r?.id !== 1, `got ${JSON.stringify(r)}`);
  }
}

// 10개 구단 전부: player 경로가 로스터 소속팀을 그대로 따른다.
{
  const perTeam = new Map<number, RosterRow>();
  for (const p of roster) if (!perTeam.has(p.teamId)) perTeam.set(p.teamId, p);
  check("로스터가 10개 구단을 모두 덮는다", perTeam.size === 10, `got ${perTeam.size}`);
  let ok = 0;
  for (const [teamId, p] of perTeam) {
    const r = resolveCollectorTeam("player", p.kboId);
    if (r?.id === teamId && r.slug === getTeamById(teamId)?.slug) ok++;
    else console.log(`   · 불일치 ${p.name}(${p.kboId}) want=${teamId} got=${JSON.stringify(r)}`);
  }
  check("player 경로: 10개 구단 대표선수 전부 소속팀 파생", ok === perTeam.size, `${ok}/${perTeam.size}`);
}

// team 경로: slug 그대로.
{
  const slugs = ["lg", "kia", "doosan", "kt", "ssg", "nc", "lotte", "samsung", "hanwha", "kiwoom"];
  let ok = 0;
  for (const slug of slugs) {
    const team = getTeamBySlug(slug);
    const r = resolveCollectorTeam("team", slug);
    if (team && r?.id === team.id && r.slug === team.slug) ok++;
    else console.log(`   · 불일치 team/${slug} got=${JSON.stringify(r)}`);
  }
  check("team 경로: 10개 구단 slug 전부 파생", ok === slugs.length, `${ok}/${slugs.length}`);
}

// 해석 불가 → null (임의 팀 fallback 금지). null 이 아니면 틀린 팀 피드에 노출된다.
{
  check("미등록 kboId → null", resolveCollectorTeam("player", "00000") === null);
  check("미상 구단 slug → null", resolveCollectorTeam("team", "nonexistent") === null);
  check("board_id 없음 → null", resolveCollectorTeam("player", null) === null);
  check("알 수 없는 board_type → null", resolveCollectorTeam("free", "lg") === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// ② publisher 배선 — 파생값이 실제 insert 에 결속돼 있는가
// ─────────────────────────────────────────────────────────────────────────────
{
  const src = read("src/lib/gif-collector/publisher.ts");

  check(
    "publisher 가 resolveCollectorTeam 결과를 insert 에 쓴다",
    /const\s+collectorTeam\s*=\s*resolveCollectorTeam\(/.test(src),
    "파생 호출이 사라지면 스냅샷이 다시 봇 프로필로 회귀한다",
  );
  check(
    "author_team_id_snapshot 이 콘텐츠 팀에서 온다",
    /author_team_id_snapshot:\s*collectorTeam\.id/.test(src),
    "봇 프로필 team_id 를 쓰면 전 구단 글이 LG 팬으로 찍힌다",
  );
  check(
    "team_tags(공개범위)도 같은 파생값을 쓴다 — 배지/범위 SSOT 단일화",
    /team_tags:\s*\[collectorTeam\.slug\]/.test(src),
  );
  check(
    "봇 프로필 team_id 를 스냅샷 소스로 읽지 않는다",
    !/botProfile\?\.team_id/.test(src),
    "profiles.team_id 조회가 되살아나면 사고 재발",
  );
  check(
    "해석 불가 시 발행 철회(임의 팀 금지)",
    /if\s*\(!collectorTeam\)[\s\S]{0,200}rejectAndReturn\(/.test(src),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 렌더 계약 — 스냅샷이 실제 작성자 배지로 나가는 경로
// ─────────────────────────────────────────────────────────────────────────────
{
  const header = read("src/components/community/CommunityAuthorHeader.tsx");
  check(
    "작성자 헤더가 teamId 로 팀 배지를 그린다",
    /TeamBadge[^>]*teamId=\{teamId\}/.test(header),
  );
  check(
    '작성자 배지는 "팬" 접미사를 붙인다(공개범위 배지와 구분)',
    /suffix="팬"/.test(header),
  );

  const authorTeam = read("src/lib/utils/post-author-team.ts");
  check(
    "author_team_id_snapshot 이 profiles.team_id 보다 우선",
    /author_team_id_snapshot\s*!=\s*null\)\s*return\s+post\.author_team_id_snapshot/.test(authorTeam),
    "우선순위가 뒤집히면 봇 프로필 LG 가 다시 이긴다",
  );
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
