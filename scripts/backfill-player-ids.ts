/**
 * 1회성 백필: community 영상의 player_ids를 제목 매칭으로 채움
 * Usage: npx tsx scripts/backfill-player-ids.ts
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

const TEAM_PATTERNS: Array<{ team: string; regex: RegExp }> = [
  { team: "LG", regex: /LG|엘지|트윈스/i },
  { team: "두산", regex: /두산|베어스/ },
  { team: "KT", regex: /KT|케이티|위즈/i },
  { team: "SSG", regex: /SSG|에스에스지|랜더스/i },
  { team: "NC", regex: /NC|엔씨|다이노스/i },
  { team: "KIA", regex: /KIA|기아|타이거즈/i },
  { team: "삼성", regex: /삼성|라이온즈/ },
  { team: "롯데", regex: /롯데|자이언츠/ },
  { team: "한화", regex: /한화|이글스/ },
  { team: "키움", regex: /키움|히어로즈/ },
];

function detectTeam(title: string): string {
  for (const { team, regex } of TEAM_PATTERNS) {
    if (regex.test(title)) return team;
  }
  return "";
}

function matchPlayers(title: string, players: Player[]): string[] {
  const titleTeam = detectTeam(title);
  const nameGroups = new Map<string, Player[]>();
  for (const p of players) {
    const g = nameGroups.get(p.name);
    if (g) g.push(p);
    else nameGroups.set(p.name, [p]);
  }

  const matched = new Set<string>();
  for (const p of players) {
    if (p.name.length < 2 || matched.has(p.kbo_id)) continue;
    if (!title.includes(p.name)) continue;

    const group = nameGroups.get(p.name)!;
    if (group.length > 1 && titleTeam) {
      const teamMatch = group.find((g) => g.team === titleTeam);
      if (teamMatch) matched.add(teamMatch.kbo_id);
    } else {
      matched.add(p.kbo_id);
    }
  }
  return Array.from(matched);
}

async function main() {
  // Load players from batter + pitcher
  const [batters, pitchers] = await Promise.all([
    supabase.from("player_stats_batter").select("kbo_id, name, team"),
    supabase.from("player_stats_pitcher").select("kbo_id, name, team"),
  ]);

  const seen = new Set<string>();
  const players: Player[] = [];
  for (const r of [...(batters.data ?? []), ...(pitchers.data ?? [])]) {
    if (seen.has(r.kbo_id)) continue;
    seen.add(r.kbo_id);
    players.push({ kbo_id: r.kbo_id, name: r.name, team: r.team });
  }
  console.log(`Loaded ${players.length} players`);

  // Load community videos with empty player_ids (paginated)
  let updated = 0;
  let taggedTotal = 0;
  let page = 0;
  const PAGE_SIZE = 1000;

  while (true) {
    const { data: videos, error } = await supabase
      .from("videos")
      .select("video_id, title, player_ids")
      .in("source_type", ["community_short", "community_long"])
      .or("player_ids.is.null,player_ids.eq.{}")
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) {
      console.error("Fetch error:", error.message);
      process.exit(1);
    }

    if (!videos || videos.length === 0) break;

    console.log(`Page ${page + 1}: ${videos.length} videos`);

    const batch: Array<{ video_id: string; player_ids: string[]; player_id: string | null }> = [];
    for (const v of videos) {
      const ids = matchPlayers(v.title, players);
      if (ids.length === 0) continue;
      batch.push({
        video_id: v.video_id,
        player_ids: ids,
        player_id: ids[0],
      });
      taggedTotal += ids.length;
    }

    for (const item of batch) {
      const { error: upErr } = await supabase
        .from("videos")
        .update({ player_ids: item.player_ids, player_id: item.player_id })
        .eq("video_id", item.video_id);
      if (upErr) {
        console.error(`Error updating ${item.video_id}: ${upErr.message}`);
      } else {
        updated++;
      }
    }

    console.log(`  Tagged ${batch.length}/${videos.length} in this page`);

    if (videos.length < PAGE_SIZE) break;
    page++; // Always advance page to avoid infinite loop
  }

  console.log(`\nDone. ${updated} videos tagged with ${taggedTotal} player matches.`);
}

main();
