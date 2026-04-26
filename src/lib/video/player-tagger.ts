/**
 * 영상 제목/설명에서 선수명·별명 매칭 → player_ids 반환
 * Shorts Aggregator Phase 3
 */

export interface PlayerAlias {
  kbo_id: string;
  name: string;
  team: string;
  aliases: string[];
}

/** 선수 사전 로드 (Supabase players_roster 기반) */
export async function loadPlayerAliases(
  supabase: { from: (t: string) => any },
): Promise<PlayerAlias[]> {
  const { data } = await supabase
    .from("players_roster")
    .select("kbo_id, name, team, aliases");

  if (!data) return [];

  return data.map((r: any) => ({
    kbo_id: r.kbo_id,
    name: r.name,
    team: r.team,
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
  }));
}

/**
 * 텍스트에서 매칭되는 player kbo_ids 반환
 * 이름 + aliases 모두 체크, 2글자 이상만 매칭 (노이즈 방지)
 */
export function matchPlayers(
  text: string,
  players: PlayerAlias[],
): string[] {
  const matched: string[] = [];

  for (const p of players) {
    const names = [p.name, ...p.aliases].filter((n) => n.length >= 2);
    for (const name of names) {
      if (text.includes(name)) {
        matched.push(p.kbo_id);
        break;
      }
    }
  }

  return matched;
}
