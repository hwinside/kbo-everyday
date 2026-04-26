/**
 * 영상 제목/설명에서 선수명·별명 매칭 → player_ids 반환
 *
 * 데이터 소스: player_stats_batter + player_stats_pitcher (UNION)
 * 동명이인 해소: 영상 제목에서 팀명이 감지되면 해당 팀 선수를 우선 매칭
 */

import { detectTeamFromTitle } from "./team-detector";

export interface PlayerAlias {
  kbo_id: string;
  name: string;
  team: string;
  aliases: string[];
}

/** 선수 사전 로드 (batter + pitcher 통합) */
export async function loadPlayerAliases(
  supabase: { from: (t: string) => any },
): Promise<PlayerAlias[]> {
  const [batters, pitchers] = await Promise.all([
    supabase
      .from("player_stats_batter")
      .select("kbo_id, name, team"),
    supabase
      .from("player_stats_pitcher")
      .select("kbo_id, name, team"),
  ]);

  const seen = new Set<string>();
  const result: PlayerAlias[] = [];

  for (const r of [...(batters.data ?? []), ...(pitchers.data ?? [])]) {
    if (seen.has(r.kbo_id)) continue;
    seen.add(r.kbo_id);
    result.push({
      kbo_id: r.kbo_id,
      name: r.name,
      team: r.team,
      aliases: [],
    });
  }

  // players_roster aliases 보충 (있으면)
  const { data: roster } = await supabase
    .from("players_roster")
    .select("kbo_id, aliases");
  if (roster) {
    const aliasMap = new Map<string, string[]>();
    for (const r of roster) {
      if (Array.isArray(r.aliases) && r.aliases.length > 0) {
        aliasMap.set(r.kbo_id, r.aliases);
      }
    }
    for (const p of result) {
      const a = aliasMap.get(p.kbo_id);
      if (a) p.aliases = a;
    }
  }

  return result;
}

/** 동명이인 그룹 사전 빌드 (이름 → kbo_id[]) */
function buildHomonymMap(players: PlayerAlias[]): Map<string, PlayerAlias[]> {
  const map = new Map<string, PlayerAlias[]>();
  for (const p of players) {
    const group = map.get(p.name);
    if (group) group.push(p);
    else map.set(p.name, [p]);
  }
  return map;
}

/**
 * 텍스트에서 매칭되는 player kbo_ids 반환
 *
 * 동명이인 해소:
 * - 제목에서 팀명이 감지되면 해당 팀 선수를 우선
 * - 팀 감지 안 되면 동명이인 모두 포함 (recall 우선)
 * - 2글자 이상만 매칭 (노이즈 방지)
 */
export function matchPlayers(
  text: string,
  players: PlayerAlias[],
): string[] {
  const titleTeam = detectTeamFromTitle(text, "");
  const homonyms = buildHomonymMap(players);
  const matched: string[] = [];
  const matchedIds = new Set<string>();

  for (const p of players) {
    if (matchedIds.has(p.kbo_id)) continue;
    const names = [p.name, ...p.aliases].filter((n) => n.length >= 2);
    for (const name of names) {
      if (!text.includes(name)) continue;

      // 동명이인 체크
      const group = homonyms.get(p.name);
      if (group && group.length > 1 && titleTeam) {
        // 제목에서 팀이 감지됨 → 해당 팀 선수만
        const teamMatch = group.find((g) => g.team === titleTeam);
        if (teamMatch && !matchedIds.has(teamMatch.kbo_id)) {
          matchedIds.add(teamMatch.kbo_id);
          matched.push(teamMatch.kbo_id);
        }
      } else {
        matchedIds.add(p.kbo_id);
        matched.push(p.kbo_id);
      }
      break;
    }
  }

  return matched;
}
