/**
 * 백필 v2: precision 정책 적용 — 팀명+선수명 동시 확인
 *
 * 1) 기존 player_ids 전체 초기화 (이전 백필은 팀명 미확인)
 * 2) 제목에서 팀명 감지 → 해당 팀 선수만 매칭
 * 3) team_id도 제목 기반으로 재배정 (community 영상)
 *
 * Usage: npx tsx scripts/backfill-player-ids-v2.ts
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface Player {
  kbo_id: string;
  name: string;
  team: string;
}

// ---- team-detector (inline) ----
const TEAM_PATTERNS: [string, RegExp][] = [
  ["LG", /\bLG\b|트윈스|엘지/i],
  ["두산", /두산|베어스/],
  ["KT", /\bKT\b|위즈|케이티/i],
  ["SSG", /\bSSG\b|랜더스|에스에스지/i],
  ["NC", /\bNC\b|다이노스|엔씨/i],
  ["KIA", /\bKIA\b|타이거즈|기아/i],
  ["롯데", /롯데|자이언츠/],
  ["삼성", /삼성|라이온즈/],
  ["한화", /한화|이글스/],
  ["키움", /키움|히어로즈/],
];

function detectTeam(title: string): string {
  for (const [team, re] of TEAM_PATTERNS) {
    if (re.test(title)) return team;
  }
  return "ETC";
}

function detectAllTeams(title: string): string[] {
  const teams: string[] = [];
  for (const [team, re] of TEAM_PATTERNS) {
    if (re.test(title)) teams.push(team);
  }
  return teams;
}

// ---- player matching (precision: 팀명+선수명) ----
function matchPlayersPrecision(title: string, players: Player[]): string[] {
  const titleTeams = detectAllTeams(title);
  if (titleTeams.length === 0) return []; // 팀명 없으면 매칭 불가

  const matched: string[] = [];
  for (const p of players) {
    if (p.name.length < 2) continue;
    if (!title.includes(p.name)) continue;
    if (titleTeams.includes(p.team)) {
      matched.push(p.kbo_id);
    }
  }
  return matched;
}

async function main() {
  // 1. Load players
  const [batters, pitchers] = await Promise.all([
    supabase.from("player_stats_batter").select("kbo_id, name, team"),
    supabase.from("player_stats_pitcher").select("kbo_id, name, team"),
  ]);
  const seen = new Set<string>();
  const players: Player[] = [];
  for (const r of [...(batters.data ?? []), ...(pitchers.data ?? [])]) {
    if (!r.kbo_id || seen.has(r.kbo_id)) continue;
    seen.add(r.kbo_id);
    players.push({ kbo_id: r.kbo_id, name: r.name, team: r.team });
  }
  console.log(`Loaded ${players.length} players`);

  // 2. Reset ALL community video player_ids (이전 부정확 백필 제거)
  console.log("Resetting existing community player_ids...");
  const { error: resetErr } = await supabase
    .from("videos")
    .update({ player_ids: [], player_id: null })
    .in("source_type", ["community_short", "community_long"])
    .neq("player_ids", "{}");
  if (resetErr) console.error("Reset error:", resetErr.message);

  // 3. Process all community videos with precision matching + team_id fix
  let page = 0;
  const PAGE_SIZE = 1000;
  let totalUpdated = 0;
  let totalTagged = 0;
  let totalTeamFixed = 0;

  while (true) {
    const { data: videos, error } = await supabase
      .from("videos")
      .select("video_id, title, team_id, source_type")
      .in("source_type", ["community_short", "community_long"])
      .order("published_at", { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) { console.error("Fetch error:", error.message); break; }
    if (!videos || videos.length === 0) break;

    console.log(`Page ${page + 1}: ${videos.length} videos`);

    for (const v of videos) {
      const playerIds = matchPlayersPrecision(v.title, players);
      const detectedTeam = detectTeam(v.title);

      const needsUpdate = playerIds.length > 0 || (v.team_id === "ETC" && detectedTeam !== "ETC");
      if (!needsUpdate) continue;

      const updates: Record<string, any> = {};
      if (playerIds.length > 0) {
        updates.player_ids = playerIds;
        updates.player_id = playerIds[0];
        totalTagged++;
      }
      if (v.team_id === "ETC" && detectedTeam !== "ETC") {
        updates.team_id = detectedTeam;
        totalTeamFixed++;
      }

      const { error: upErr } = await supabase
        .from("videos")
        .update(updates)
        .eq("video_id", v.video_id);
      if (upErr) console.error(`Error ${v.video_id}: ${upErr.message}`);
      else totalUpdated++;
    }

    console.log(`  Updated: ${totalUpdated} (tagged: ${totalTagged}, team-fixed: ${totalTeamFixed})`);

    if (videos.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`\nDone.`);
  console.log(`  Total updated: ${totalUpdated}`);
  console.log(`  Player tagged (precision): ${totalTagged}`);
  console.log(`  Team re-assigned: ${totalTeamFixed}`);
}

main();
