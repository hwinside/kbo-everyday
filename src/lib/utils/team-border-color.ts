import { getTeamById } from "@/lib/constants/teams";

/**
 * 팀 컬러의 밝기에 따라 border에 적합한 색상+opacity를 동적 계산.
 * 어두운 색은 colorLight를 사용하고, 밝은 색은 원본에 opacity를 적용.
 */
export function getTeamBorderColor(
  hexColor: string,
  colorLight?: string
): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  // Perceived brightness (0-255)
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  if (brightness < 80 && colorLight) {
    // 어두운 팀 → colorLight 사용 + opacity
    return `${colorLight}50`; // ~31% opacity
  }

  // 밝은 팀 → 원본 컬러 + opacity
  return `${hexColor}59`; // ~35% opacity
}

/**
 * teamId로 바로 border color를 가져오는 헬퍼.
 * colorPrimary + colorLight를 자동으로 처리.
 */
export function getTeamBorderColorById(teamId: number): string | undefined {
  const team = getTeamById(teamId);
  if (!team) return undefined;
  return getTeamBorderColor(team.colorPrimary, team.colorLight);
}
