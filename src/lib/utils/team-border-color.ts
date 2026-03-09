/**
 * 팀 컬러의 밝기에 따라 border에 적합한 opacity를 동적 계산.
 * 어두운 색은 opacity를 높이고, 밝은 색은 낮춰서 다크 배경에서 항상 보이도록 함.
 */
export function getTeamBorderColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  // Perceived brightness (0-255)
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  // 밝기가 낮을수록 높은 opacity, 밝을수록 낮은 opacity
  // 범위: 0.25 (밝은 색) ~ 0.70 (어두운 색)
  let opacity: number;
  if (brightness < 30) {
    // 거의 검정 (두산, 롯데) → colorLight 사용이 더 나을 수 있지만
    // colorPrimary 기준으로 최대 opacity
    opacity = 0.70;
  } else if (brightness < 80) {
    // 어두운 색 (NC, 삼성)
    opacity = 0.55;
  } else {
    // 밝은 색 (LG, KIA, SSG)
    opacity = 0.35;
  }

  const alphaHex = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0");

  return `${hexColor}${alphaHex}`;
}
