import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { getTeamById, getTeamBySlug } from "@/lib/constants/teams";

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
