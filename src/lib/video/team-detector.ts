/**
 * 영상 제목에서 KBO 10개 팀 감지
 * 커뮤니티 채널 영상의 team_id 배정에 사용
 */

import { hasLgBaseballContext } from "./shorts-relevance";

const TEAM_PATTERNS: [string, RegExp][] = [
  ["두산", /두산|베어스/],
  ["KT", /\bKT\b|위즈|케이티/i],
  ["SSG", /\bSSG\b|랜더스|에스에스지/i],
  ["NC", /\bNC\b|다이노스|엔씨/i],
  ["KIA", /\bKIA\b|타이거즈|기아/i],
  ["롯데", /롯데|자이언츠/],
  ["삼성", /삼성|라이온즈/],
  ["한화", /한화|이글스/],
  ["키움", /키움|히어로즈/],
];

const LG_NAME_PATTERN = /(^|[^A-Za-z0-9])LG(?![A-Za-z0-9])|엘지/i;

function hasLgTeamSignal(title: string): boolean {
  if (title.includes("트윈스")) return true;
  return LG_NAME_PATTERN.test(title) && hasLgBaseballContext(title);
}

/**
 * 제목에서 첫 번째 매칭되는 팀 shortName 반환.
 * 매칭 없으면 "ETC"
 */
export function detectTeamFromTitle(title: string): string {
  if (hasLgTeamSignal(title)) return "LG";
  for (const [team, re] of TEAM_PATTERNS) {
    if (re.test(title)) return team;
  }
  return "ETC";
}

/**
 * 제목에서 매칭되는 모든 팀 반환 (동명이인 해소용)
 */
export function detectAllTeamsFromTitle(title: string): string[] {
  const teams: string[] = [];
  if (hasLgTeamSignal(title)) teams.push("LG");
  for (const [team, re] of TEAM_PATTERNS) {
    if (re.test(title)) teams.push(team);
  }
  return teams;
}
