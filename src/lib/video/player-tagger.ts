/**
 * 영상 제목에서 선수명 매칭 → player_ids 반환
 * Shorts Aggregator Phase 3
 *
 * Precision 정책:
 *   - 공식 채널 (channelTeam): 채널 소속 선수만 매칭
 *   - 커뮤니티 채널 (T1~T3): 선수명만으로 매칭 허용
 *     (제목에 팀명 있으면 해당 팀 선수만, 없으면 전체 허용)
 *   - 오탐은 수동 발라내기로 대응 (하린아빠 지시 2026-04-27)
 */

import { detectAllTeamsFromTitle } from "./team-detector";

export interface PlayerAlias {
  kbo_id: string;
  name: string;
  team: string;      // shortName: "LG", "두산", etc.
  aliases: string[];
}

const PLAYER_NAME_SUFFIXES = [
  "으로",
  "부터",
  "까지",
  "에게",
  "한테",
  "께서",
  "선수",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "도",
  "만",
  "와",
  "과",
  "랑",
  "로",
  "께",
];

/** `김민`이 `김민석`에 걸리는 한글 prefix 오탐 없이 선수명을 찾는다. */
export function titleIncludesPlayerName(title: string, name: string): boolean {
  let index = title.indexOf(name);
  while (index !== -1) {
    const rest = title.slice(index + name.length);
    if (
      rest === "" ||
      !/[가-힣]/.test(rest[0]) ||
      PLAYER_NAME_SUFFIXES.some((suffix) => rest.startsWith(suffix))
    ) {
      return true;
    }
    index = title.indexOf(name, index + 1);
  }
  return false;
}

/** 선수 태깅에 필요한 채널별 제목 문맥 계약 */
export function hasRequiredPlayerContext(
  title: string,
  channelTeam?: string | null,
  channelTier?: number | null,
  ambiguousName = false,
): boolean {
  if (channelTeam) return true;
  if (ambiguousName && channelTier != null && channelTier >= 2) {
    return detectAllTeamsFromTitle(title).length > 0;
  }
  return true;
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
 * @param channelTeam - 공식 채널의 team_affinity (있으면 해당 팀 선수만 매칭)
 * @param channelTier - channel_pool tier (1=방송사/공식급, 2+=커뮤니티)
 */
export function matchPlayers(
  title: string,
  players: PlayerAlias[],
  channelTeam?: string | null,
  channelTier?: number | null,
): string[] {
  const titleTeams = detectAllTeamsFromTitle(title);
  const matched: string[] = [];

  for (const p of players) {
    const names = [p.name, ...p.aliases].filter((n) => n.length >= 2);
    const nameFound = names.some((name) => titleIncludesPlayerName(title, name));
    if (!nameFound) continue;
    const ambiguousName = players.some(
      (candidate) => candidate.kbo_id !== p.kbo_id && candidate.name === p.name,
    );
    if (!hasRequiredPlayerContext(title, channelTeam, channelTier, ambiguousName)) continue;

    if (channelTeam) {
      // 공식 채널: 채널 팀 소속 선수만 매칭 (cross-team bleed 방지)
      if (p.team === channelTeam) {
        matched.push(p.kbo_id);
      }
    } else {
      // 방송사/공식급(T1)은 선수명만 허용. 일반·커뮤니티 채널(T2+)에서
      // 동명이인 선수명은 팀명도 함께 있어야 한다. 정치인 김민석처럼 같은 이름이
      // 여러 KBO 선수에게 동시에 태깅되는 오탐만 막고, 고유 선수명 recall은 보존한다.
      // 제목에 팀명이 있으면 해당 팀 선수만, 무팀명 고유 선수는 전체 허용
      if (titleTeams.length === 0 || titleTeams.includes(p.team)) {
        matched.push(p.kbo_id);
      }
    }
  }

  return matched;
}
