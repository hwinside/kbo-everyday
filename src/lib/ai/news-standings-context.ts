import { isWithinRegularSeasonWindow } from "@/lib/constants/season";
import { STANDINGS_ACCURACY_RULES, STANDINGS_UNAVAILABLE_RULES } from "./standings-guard";

export function newsStandingsContext(date: string, standings: string | null): string {
  if (!isWithinRegularSeasonWindow(date.replaceAll("-", ""))) {
    return "\n## 정규시즌 밖 뉴스 문맥\n정규시즌 순위표를 현재 순위 경쟁의 근거로 사용하지 않는다. 포스트시즌 경기 결과로 순위·승차가 변하거나 자리를 굳혔다고 서술하지 않는다. 라운드·시리즈 전적·진출·탈락은 제공된 기사에 명시된 사실만 사용한다. 정규시즌 최종 순위가 기사에 명시돼 있으면 고정 시드라는 점을 분명히 한다.\n";
  }
  return standings
    ? `\n## 공식 순위표 (오늘 기준 — 순위 관련 서술의 유일한 근거)\n${standings}\n${STANDINGS_ACCURACY_RULES}\n`
    : `\n${STANDINGS_UNAVAILABLE_RULES}\n`;
}
