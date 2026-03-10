import { TEAMS, getTeamBgColor } from "@/lib/constants/teams";

export function getTeamShortName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? "";
}

export function getTeamColor(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.colorLight ?? "#999";
}

export function getTeamBgColorById(teamId: number) {
  const team = TEAMS.find((t) => t.id === teamId);
  return team ? getTeamBgColor(team) : "#666";
}

export function getTeamLogo(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.logoPath ?? "";
}

export function getTeamName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.name ?? "";
}
