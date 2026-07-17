import { getTeamById, getTeamBgColor, hexLuminance } from "@/lib/constants/teams";

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

// getTeamById로 조회 — 정규 10구단 + 올스타(나눔/드림 101/102)까지 해석한다.
// TEAMS 직접 find는 올스타 teamId를 못 찾아 빈값을 반환해 홈 '전체 경기 현황'
// 올스타 카드가 로고/팀명 없이 렌더됐다(2026-07-11 fix).
export function getTeamShortName(teamId: number) {
  return getTeamById(teamId)?.shortName ?? "";
}

export function getTeamColor(teamId: number) {
  return getTeamById(teamId)?.colorLight ?? "#999";
}

export function getTeamBgColorById(teamId: number) {
  const team = getTeamById(teamId);
  return team ? getTeamBgColor(team) : "#666";
}

export function getTeamLogo(teamId: number) {
  return getTeamById(teamId)?.logoPath ?? "";
}

export function getTeamName(teamId: number) {
  return getTeamById(teamId)?.name ?? "";
}
