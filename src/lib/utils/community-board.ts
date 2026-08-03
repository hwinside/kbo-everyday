import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { getTeamById, getTeamBySlug } from "@/lib/constants/teams";
import { parsePlayerTag } from "@/lib/utils/player-tags";

export interface CommunitySourceLabel {
  text: string;
  teamId?: number;
  playerName?: string;
}

export function getCommunitySourceLabel(boardType: string, boardId: string): CommunitySourceLabel {
  if (boardType === "team") {
    const team = getTeamBySlug(boardId);
    return team
      ? { text: `${team.shortName} 게시판`, teamId: team.id }
      : { text: "팀 게시판" };
  }

  if (boardType === "player") {
    const player = PLAYERS_ROSTER.find((p) => p.kboId === boardId);
    if (!player) return { text: "선수 게시판" };
    const team = getTeamById(player.teamId);
    return {
      text: `${team?.shortName ?? player.team} ${player.name}`,
      teamId: player.teamId,
      playerName: player.name,
    };
  }

  if (boardType === "free") {
    return { text: "자유게시판" };
  }

  const team = getTeamById(Number(boardId));
  return team ? { text: team.shortName, teamId: team.id } : { text: "게시판" };
}

interface SourcePostLike {
  board_type: string;
  board_id: string;
  team_tags?: string[] | null;
  player_tags?: string[] | null;
}

/** 태그를 우선하고 레거시 board를 폴백으로 쓰는 게시글 콘텐츠 소속 라벨. */
export function getPostSourceLabel(post: SourcePostLike): CommunitySourceLabel {
  const players = new Map<string, { name: string; teamId?: number }>();
  const addPlayer = (kboId: string | null, displayName: string) => {
    const roster = kboId
      ? PLAYERS_ROSTER.find((player) => player.kboId === kboId)
      : PLAYERS_ROSTER.find((player) => player.name === displayName);
    const key = roster?.kboId ?? kboId ?? `name:${displayName}`;
    if (!players.has(key)) players.set(key, { name: roster?.name ?? displayName, teamId: roster?.teamId });
  };

  if (post.board_type === "player" && post.board_id) {
    const roster = PLAYERS_ROSTER.find((player) => player.kboId === post.board_id);
    if (roster) addPlayer(roster.kboId, roster.name);
  }
  for (const tag of post.player_tags ?? []) {
    const { kboId, displayName } = parsePlayerTag(tag);
    addPlayer(kboId, displayName);
  }

  const playerValues = [...players.values()];
  if (playerValues.length > 0) {
    const names = playerValues.map((player) => player.name);
    const display = `${names.slice(0, 2).join("/")}${names.length > 2 ? ` 외 ${names.length - 2}명` : ""}`;
    const teamIds = new Set(playerValues.map((player) => player.teamId).filter((id): id is number => id != null));
    if (teamIds.size === 1) {
      const teamId = [...teamIds][0];
      const team = getTeamById(teamId);
      return { text: `${team?.shortName ?? ""} ${display}`.trim(), teamId, playerName: display };
    }
    return { text: display };
  }

  const taggedTeams = (post.team_tags ?? [])
    .map((slug) => getTeamBySlug(slug))
    .filter((team): team is NonNullable<ReturnType<typeof getTeamBySlug>> => !!team);
  const uniqueTeams = [...new Map(taggedTeams.map((team) => [team.id, team])).values()];
  if (uniqueTeams.length === 1) {
    return { text: uniqueTeams[0].shortName, teamId: uniqueTeams[0].id };
  }
  if (uniqueTeams.length > 1) {
    return { text: uniqueTeams.map((team) => team.shortName).join("/") };
  }

  return getCommunitySourceLabel(post.board_type, post.board_id);
}
