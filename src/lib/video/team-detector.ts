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

/** 수집 채널 신호 — 검증 야구채널(tier 1 방송사/공식급 또는 team affinity)이면
 *  LG 야구 문맥 긍정 신호로 인정 (2026-07-24 삼순 라운드3 A안). */
export interface TeamDetectOptions {
  trustedChannel?: boolean;
}

function hasLgTeamSignal(title: string, options: TeamDetectOptions): boolean {
  if (title.includes("트윈스")) return true;
  return LG_NAME_PATTERN.test(title) && hasLgBaseballContext(title, options);
}

/**
 * 제목에서 첫 번째 매칭되는 팀 shortName 반환.
 * 매칭 없으면 "ETC"
 */
export function detectTeamFromTitle(
  title: string,
  options: TeamDetectOptions = {},
): string {
  if (hasLgTeamSignal(title, options)) return "LG";
  for (const [team, re] of TEAM_PATTERNS) {
    if (re.test(title)) return team;
  }
  return "ETC";
}

/**
 * 제목에서 매칭되는 모든 팀 반환 (동명이인 해소용)
 */
export function detectAllTeamsFromTitle(
  title: string,
  options: TeamDetectOptions = {},
): string[] {
  const teams: string[] = [];
  if (hasLgTeamSignal(title, options)) teams.push("LG");
  for (const [team, re] of TEAM_PATTERNS) {
    if (re.test(title)) teams.push(team);
  }
  return teams;
}
