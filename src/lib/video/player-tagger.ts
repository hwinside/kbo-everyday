/**
 * 영상 제목에서 선수명 매칭 → player_ids 반환
 * Shorts Aggregator Phase 3
 *
 * Precision 우선 정책:
 *   - 커뮤니티 채널: 팀명 + 선수명 동시 확인 시에만 매칭
 *   - 공식 채널: 선수명만으로 매칭 OK (채널에 팀 컨텍스트 내재)
 */

import { detectAllTeamsFromTitle } from "./team-detector";

export interface PlayerAlias {
  kbo_id: string;
  name: string;
  team: string;      // shortName: "LG", "두산", etc.
  aliases: string[];
}

/**
 * 선수 사전 로드 — player_stats_batter + pitcher 기반
 * (players_roster는 빈 테이블이라 사용 안 함)
 */
export async function loadPlayerAliases(
  supabase: { from: (t: string) => any },
): Promise<PlayerAlias[]> {
  const [batters, pitchers] = await Promise.all([
    supabase.from("player_stats_batter").select("kbo_id, name, team"),
    supabase.from("player_stats_pitcher").select("kbo_id, name, team"),
  ]);

  const seen = new Set<string>();
  const result: PlayerAlias[] = [];

  for (const row of [...(batters.data ?? []), ...(pitchers.data ?? [])]) {
    if (!row.kbo_id || seen.has(row.kbo_id)) continue;
    seen.add(row.kbo_id);
    result.push({
      kbo_id: row.kbo_id,
      name: row.name,
      team: row.team,
      aliases: [],  // aliases 컬럼 추가되면 여기서 로드
    });
  }

  return result;
}

/**
 * 제목에서 매칭되는 player kbo_ids 반환
 *
 * @param title - 영상 제목
 * @param players - 선수 사전
 * @param channelTeam - 공식 채널의 team_affinity (있으면 선수명만으로 매칭 허용)
 */
export function matchPlayers(
  title: string,
  players: PlayerAlias[],
  channelTeam?: string | null,
): string[] {
  const titleTeams = detectAllTeamsFromTitle(title);
  const matched: string[] = [];

  for (const p of players) {
    const names = [p.name, ...p.aliases].filter((n) => n.length >= 2);
    const nameFound = names.some((name) => title.includes(name));
    if (!nameFound) continue;

    // Precision 규칙: 팀 컨텍스트 있어야 매칭
    if (channelTeam) {
      // 공식 채널: 채널 팀과 선수 팀이 일치하면 OK
      if (p.team === channelTeam) {
        matched.push(p.kbo_id);
      }
      // 공식 채널이지만 다른 팀 선수명이 제목에 있을 수도 (예: "LG vs 두산 문보경")
      // → 제목에 해당 선수 팀명도 있으면 매칭
      else if (titleTeams.includes(p.team)) {
        matched.push(p.kbo_id);
      }
    } else {
      // 커뮤니티 채널: 제목에 팀명 + 선수명 동시 확인만 매칭
      if (titleTeams.includes(p.team)) {
        matched.push(p.kbo_id);
      }
    }
  }

  return matched;
}
