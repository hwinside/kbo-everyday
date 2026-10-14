/** Only regular-season games may consume the standings and consecutive-series helpers. */
export function summaryCompetitionPolicy(srId: string) {
  const regular = srId === "0";
  const label = ({ "3": "준플레이오프", "4": "와일드카드 결정전", "5": "플레이오프", "7": "한국시리즈", "1": "시범경기", "9": "올스타전" } as Record<string, string>)[srId];
  return {
    regular,
    label: label ? `${label} 경기입니다.` : null,
    instructions: regular ? "" : `\n## 최우선 경기 구분 규칙\n이 경기는 ${label ?? "정규시즌 외"} 경기입니다. 위 정규시즌 시리즈·순위 관련 예시와 지시를 적용하지 마세요. 정규시즌 순위·승차·승률에 영향을 주지 않습니다. 순위 경쟁, 자리 굳히기, 승차 벌리기, 위닝시리즈·스윕을 모든 필드에서 언급하지 마세요. standingsImpact와 seriesContext는 null로 출력하세요. 단계별 누적 전적·시드·진출 판정은 제공되지 않았습니다. 진출·탈락·우승 확정이나 시리즈 종료/리드/전적을 추정하지 마세요. insight와 headline은 이 경기의 점수·박스스코어 사실만 설명하세요.\n`,
  };
}

/** Reject leaked regular-season/unsupported qualification claims anywhere in the narrative. */
export function invalidPostseasonNarrative(summary: Record<string, unknown>): boolean {
  const text = JSON.stringify({ ...summary, seriesContext: null, standingsImpact: null });
  return /순위|승차|승률|[1-9]위|위닝\s*시리즈|스윕|진출|탈락|우승|시리즈.{0,30}(?:마쳤|마무리|리드|승\s*\d+패|종료)/.test(text);
}
