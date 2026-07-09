import { TEAMS, getTeamBgColor, hexLuminance } from "@/lib/constants/teams";

/**
 * 배경 hex 위에 얹을 글자색을 대비(WCAG contrast ratio) 최대가 되게 고른다.
 * 밝은 팀색(예: 한화 #FF6600)엔 어두운 글자, 어두운 팀색엔 흰 글자.
 * 반환: "#0A0A0B"(어두운 글자) | "#FFFFFF"(흰 글자).
 */
export function readableTextColor(bgHex: string): "#0A0A0B" | "#FFFFFF" {
  const L = hexLuminance(bgHex);
  const contrastWhite = 1.05 / (L + 0.05);
  const contrastDark = (L + 0.05) / 0.05;
  return contrastDark > contrastWhite ? "#0A0A0B" : "#FFFFFF";
}

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
