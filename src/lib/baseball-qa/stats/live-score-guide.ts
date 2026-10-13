import { isTeamScoreQuestion } from "./team-record";

export const LIVE_SCORE_GUIDE_URL = "https://keubo.fan/games";

/** Navigation only: no fixture, current score, or freshness is asserted. */
export function liveScoreGuide(question: string, hasKboTeam: boolean): {
  answer: string; sourceUrl: string;
} | null {
  const q = question.normalize("NFKC").toLowerCase();
  if (!hasKboTeam && !/kbo|크보|야구/.test(q)) return null;
  if (!/지금|현재|오늘|실시간|라이브/.test(q) || !isTeamScoreQuestion(q)) return null;
  // A current navigation shortcut must not swallow historical, predictive,
  // split-stat, definition, narrative, or other-league questions.
  if (/어제|그제|지난|작년|내년|내일|모레|역대|통산|최근|전반기|후반기|상대\s*전적|누적|평균|득점권|예상|예측|전망|확률|배팅|베팅|뜻|정의|의미|유래|규칙|규정|룰|왜|이유|원인|장면|과정|분석|방법|축구|농구|배구|mlb|메이저|npb|일본|퓨처스|wbc|아시안|올스타|국가대표/.test(q)) return null;
  if (/\d{4}|\d+\s*(?:월|일|년|회)|\d+\s*[-/.]\s*\d+/.test(q)) return null;
  if (/타율|홈런|타점|안타|도루|ops|war|방어율|자책|탈삼진|순위|승률|승차|승수|패수/.test(q)) return null;
  return {
    answer: "현재 경기 점수는 이 답변에서 실시간으로 확인하지 못했습니다. 크보팬 ‘경기’ 화면에서 오늘 날짜를 선택하고 해당 경기의 점수와 진행 상태를 확인해 주세요. 경기 카드를 누르면 상세 화면으로 이동합니다.\nhttps://keubo.fan/games",
    sourceUrl: LIVE_SCORE_GUIDE_URL,
  };
}
