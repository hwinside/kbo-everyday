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
import { buildCollectorPlayerTags, resolveCollectorTeam } from "@/lib/gif-collector/collector-team";
import { parsePlayerTag } from "@/lib/utils/player-tags";
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
// ①' buildCollectorPlayerTags — 최애선수 게시글 알림의 유일한 근거
//
// 사고: 2026-08-16 하린아빠 — 콜렉터 글에 최애선수 알림이 안 온다.
// 원인은 publisher 가 posts INSERT 에 player_tags 를 안 넣은 것. 디스패처는 빈 태그면
// 그 자리에서 return [] 하므로 푸시 시도 자체가 0건이었다(최근 글 50건 전부 []).
// ─────────────────────────────────────────────────────────────────────────────
{
  // 사고 재현 케이스: 김도영(52605) 매칭 글은 태그가 반드시 채워져야 한다.
  const kimDoyoung = roster.find((p) => p.kboId === "52605");
  const tags = buildCollectorPlayerTags("player", "52605");
  check(
    "사고 재현: matched_kbo_id=52605 → player_tags 비어있지 않다",
    tags.length === 1,
    `got ${JSON.stringify(tags)} — 빈 배열이면 최애선수 알림이 통째로 안 나간다`,
  );
  check(
    'player_tags 포맷이 커뮤니티 SSOT "kboId:이름" 와 같다',
    tags[0] === `52605:${kimDoyoung?.name}`,
    `got ${JSON.stringify(tags[0])}, want 52605:${kimDoyoung?.name}`,
  );

  // 디스패처(handlePost)가 쓰는 파싱을 그대로 태워 알림 제목이 깨지지 않는지 확인.
  {
    const [kboId, playerName] = String(tags[0]).split(":");
    check(
      "디스패처 파싱(tag.split(':')) 이 kboId/이름 양쪽을 복원",
      kboId === "52605" && !!playerName && playerName === kimDoyoung?.name,
      `got kboId=${kboId} name=${playerName}`,
    );
    const parsed = parsePlayerTag(String(tags[0]));
    check(
      "parsePlayerTag 계약도 만족(displayName 공백 아님)",
      parsed.kboId === "52605" && parsed.displayName === kimDoyoung?.name,
      `got ${JSON.stringify(parsed)}`,
    );
  }

  // 10개 구단 대표선수 전수 — 특정 팀만 태그가 살고 나머지가 죽는 부분결손을 막는다.
  {
    const perTeam = new Map<number, RosterRow>();
    for (const p of roster) if (!perTeam.has(p.teamId)) perTeam.set(p.teamId, p);
    let ok = 0;
    for (const [, p] of perTeam) {
      const t = buildCollectorPlayerTags("player", p.kboId);
      if (t.length === 1 && t[0] === `${p.kboId}:${p.name}`) ok++;
      else console.log(`   · 불일치 ${p.name}(${p.kboId}) got=${JSON.stringify(t)}`);
    }
    check("10개 구단 대표선수 전부 태그 생성", ok === perTeam.size, `${ok}/${perTeam.size}`);
  }

  // 외국인 canonical ID(FP/AQ) 도 로스터에 있으면 동일하게 태그된다.
  {
    const foreign = roster.find((p) => /^(FP|AQ)/.test(String(p.kboId)));
    if (foreign) {
      const t = buildCollectorPlayerTags("player", foreign.kboId);
      check(
        `외국인 canonical ID(${foreign.kboId}) 도 태그 생성`,
        t.length === 1 && t[0] === `${foreign.kboId}:${foreign.name}`,
        `got ${JSON.stringify(t)}`,
      );
    }
  }

  // board_type 가드(삼순 2026-08-16 NO-GO) — matcher 는 선수 식별 + 낮은 확신으로 팀판으로
  // 내려보내는 `matchedKboId≠null + boardType='team'` 상태를 실제 생성한다(matching.ts).
  // 그 글에 태그를 만들면 팀 글이 특정 선수 팬에게 잘못 알림된다.
  {
    const teamWithKboId = buildCollectorPlayerTags("team", "52605");
    check(
      "team 글은 matched_kbo_id 가 있어도 태그 없음(오발송 방지)",
      teamWithKboId.length === 0,
      `got ${JSON.stringify(teamWithKboId)} — 팀 글이 특정 선수 팬에게 알림 간다`,
    );
    check("board_type=null → 태그 없음", buildCollectorPlayerTags(null, "52605").length === 0);
    check("알 수 없는 board_type → 태그 없음", buildCollectorPlayerTags("free", "52605").length === 0);
  }

  // fail-close — 이름을 모르면 태그를 지어내지 않는다("52605:" 같은 깨진 태그 금지).
  {
    check("matched_kbo_id=null → 빈 배열", buildCollectorPlayerTags("player", null).length === 0);
    check("빈 문자열 → 빈 배열", buildCollectorPlayerTags("player", "   ").length === 0);
    const unknown = buildCollectorPlayerTags("player", "00000");
    check(
      "로스터 미등록 kboId → 빈 배열(이름 없는 태그 생성 금지)",
      unknown.length === 0,
      `got ${JSON.stringify(unknown)}`,
    );
  }
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

  // 사고 재발 방지: 태그 파생이 insert 까지 실제로 이어져 있어야 한다.
  check(
    "publisher 가 buildCollectorPlayerTags 를 board_type + matched_kbo_id 로 호출",
    /const\s+collectorPlayerTags\s*=\s*buildCollectorPlayerTags\(\s*row\.matched_board_type,\s*row\.matched_kbo_id\s*\)/.test(src),
    "호출이 사라지면 최애선수 알림이 다시 0건이 된다",
  );
  check(
    "파생된 태그가 posts insert payload 에 실린다",
    /postInsert\.player_tags\s*=\s*collectorPlayerTags/.test(src),
    "payload 에 안 실리면 DB 엔 빈 배열로 남고 디스패처가 return [] 한다",
  );
  check(
    "빈 태그는 실지 않는다(team 글 — 기존 발행 경로 무변경)",
    /if\s*\(collectorPlayerTags\.length\s*>\s*0\)\s*postInsert\.player_tags/.test(src),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ②' 알림 수신 계약 — 디스패처가 정말 player_tags 를 유일 근거로 쓰는가
// (이 게이트가 검증하는 결함의 전제 자체를 같이 박아둔다 — 디스패처가 다른 근거로
//  바뀜면 이 파생 자체가 불필요해지므로 재검토하라고 알려야 한다.)
// ─────────────────────────────────────────────────────────────────────────────
{
  const dispatch = read("src/app/api/notifications/dispatch/route.ts");
  check(
    "디스패처 handlePost 가 record.player_tags 로 대상을 찾는다",
    /const\s+tags\s*=\s*\(record\.player_tags\s+as\s+string\[\]\s*\|\s*null\)\s*\?\?\s*\[\]/.test(dispatch),
    "근거가 바뀌면 콜렉터 태그 파생 설계를 재검토해야 한다",
  );
  check(
    "태그가 비면 발송 시도 없이 종료된다(이번 결함의 직접 원인)",
    /if\s*\(!postId\s*\|\|\s*tags\.length\s*===\s*0\)\s*return\s*\[\]/.test(dispatch),
  );
  check(
    "최애선수 게시글 알림은 fav_player_post pref 로 나간다(별도 pref 없음 — 1번안)",
    /prefKey:\s*"fav_player_post"/.test(dispatch),
  );
  check(
    "작성자 본인은 제외된다(봇이 봇에게 알림 보내지 않음)",
    /new\s+Set<string>\(\[authorId\]\)/.test(dispatch),
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
