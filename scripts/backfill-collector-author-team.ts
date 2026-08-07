/**
 * 콜렉터(짤/움짤) 기존 글의 작성자 팀 스냅샷 백필.
 *
 * 2026-08-07 사고: 봇 프로필 `profiles.team_id`(seed 임의값 1=LG)를 스냅샷으로 기록해
 * KIA 김도영 글이 "LG 팬"으로 표시됨. publisher 는 콘텐츠 팀 파생으로 고쳤고,
 * 이 스크립트가 이미 발행된 글을 같은 규칙으로 맞춘다.
 *
 * 안전장치
 *   · 대상은 콜렉터 봇 2계정(author_id)이 쓴 글로 한정 — 일반 유저 글은 실제 응원팀이라 건드리지 않는다.
 *   · resolveCollectorTeam 이 null 이면 SKIP(임의 팀을 찍지 않는다).
 *   · 기본은 dry-run. 실제 쓰기는 --apply.
 *   · team_tags(공개범위)는 건드리지 않는다 — DB 트리거 계약 영역이라 이 백필의 범위 밖.
 *
 * Usage:
 *   npx tsx scripts/backfill-collector-author-team.ts            # dry-run
 *   npx tsx scripts/backfill-collector-author-team.ts --apply    # 실제 반영
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { resolveCollectorTeam } from "../src/lib/gif-collector/collector-team";
import { getTeamById } from "../src/lib/constants/teams";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APPLY = process.argv.includes("--apply");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

/** 콜렉터 봇 계정. env 로 주입하지 않으면 nickname 으로 조회한다. */
const BOT_NICKNAMES = ["짤콜렉터", "움짤콜렉터"];

const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface PostRow {
  id: number;
  board_type: string | null;
  board_id: string | null;
  author_team_id_snapshot: number | null;
  created_at: string;
}

async function main(): Promise<void> {
  const { data: bots, error: botErr } = await supa
    .from("profiles")
    .select("id, nickname, team_id")
    .in("nickname", BOT_NICKNAMES);
  if (botErr) throw botErr;
  if (!bots?.length) {
    console.error("콜렉터 봇 프로필을 찾지 못했습니다.");
    process.exit(1);
  }
  console.log(`봇 ${bots.length}개: ${bots.map((b) => `${b.nickname}(team_id=${b.team_id})`).join(", ")}`);

  const botIds = bots.map((b) => b.id as string);
  const { data: posts, error: postErr } = await supa
    .from("posts")
    .select("id, board_type, board_id, author_team_id_snapshot, created_at")
    .in("author_id", botIds)
    .order("created_at", { ascending: false })
    .returns<PostRow[]>();
  if (postErr) throw postErr;

  const changes: Array<{ id: number; from: number | null; to: number; why: string }> = [];
  const skipped: PostRow[] = [];

  for (const p of posts ?? []) {
    const team = resolveCollectorTeam(p.board_type, p.board_id);
    if (!team) {
      skipped.push(p);
      continue;
    }
    if (p.author_team_id_snapshot === team.id) continue;
    changes.push({
      id: p.id,
      from: p.author_team_id_snapshot,
      to: team.id,
      why: `${p.board_type}/${p.board_id} → ${getTeamById(team.id)?.shortName}`,
    });
  }

  console.log(`\n대상 글 ${posts?.length ?? 0}건 / 변경 ${changes.length}건 / 해석불가 SKIP ${skipped.length}건`);
  for (const c of changes) {
    const fromName = c.from != null ? getTeamById(c.from)?.shortName ?? c.from : "null";
    console.log(`  #${c.id}  ${fromName} → ${getTeamById(c.to)?.shortName}   (${c.why})`);
  }
  for (const s of skipped) {
    console.log(`  SKIP #${s.id}  ${s.board_type}/${s.board_id} — 로스터/구단 미해석, 현재값 유지(${s.author_team_id_snapshot})`);
  }

  if (!APPLY) {
    console.log("\ndry-run 입니다. 반영하려면 --apply 를 붙여 다시 실행하세요.");
    return;
  }

  let ok = 0;
  for (const c of changes) {
    const { error } = await supa
      .from("posts")
      .update({ author_team_id_snapshot: c.to })
      .eq("id", c.id);
    if (error) {
      console.error(`  ✗ #${c.id} 실패: ${error.message}`);
      continue;
    }
    ok++;
  }
  console.log(`\n반영 ${ok}/${changes.length}건 완료.`);

  // 반영 후 재검증 — 남은 불일치가 0 이어야 한다.
  const { data: after, error: afterErr } = await supa
    .from("posts")
    .select("id, board_type, board_id, author_team_id_snapshot, created_at")
    .in("author_id", botIds)
    .returns<PostRow[]>();
  if (afterErr) throw afterErr;
  const remaining = (after ?? []).filter((p) => {
    const t = resolveCollectorTeam(p.board_type, p.board_id);
    return t != null && p.author_team_id_snapshot !== t.id;
  });
  console.log(`재검증: 남은 불일치 ${remaining.length}건${remaining.length ? ` — ${remaining.map((r) => r.id).join(", ")}` : ""}`);
  if (remaining.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
