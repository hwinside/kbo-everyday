/**
 * 영상 제목에서 KBO 팀 감지
 * 커뮤니티 채널(team_affinity 없음)의 영상에 team_id를 배정할 때 사용
 */

const TEAM_KEYWORDS: Array<{ team: string; patterns: RegExp }> = [
  { team: "LG", patterns: /LG|엘지|트윈스/i },
  { team: "두산", patterns: /두산|베어스/ },
  { team: "KT", patterns: /KT|케이티|위즈/i },
  { team: "SSG", patterns: /SSG|에스에스지|랜더스/i },
  { team: "NC", patterns: /NC|엔씨|다이노스/i },
  { team: "KIA", patterns: /KIA|기아|타이거즈/i },
  { team: "삼성", patterns: /삼성|라이온즈/ },
  { team: "롯데", patterns: /롯데|자이언츠/ },
  { team: "한화", patterns: /한화|이글스/ },
  { team: "키움", patterns: /키움|히어로즈/ },
];

/**
 * 제목에서 팀명을 감지한다.
 * 여러 팀이 감지되면 첫 번째(가장 먼저 매칭)를 반환.
 * 감지 안 되면 fallbackTeam 반환.
 */
export function detectTeamFromTitle(
  title: string,
  fallbackTeam = "ETC",
): string {
  for (const { team, patterns } of TEAM_KEYWORDS) {
    if (patterns.test(title)) return team;
  }
  return fallbackTeam;
}
