/** Only regular-season games may consume the standings and consecutive-series helpers. */
export function summaryCompetitionPolicy(srId: string) {
  const regular = srId === "0";
  const label = ({ "3": "준플레이오프", "4": "와일드카드 결정전", "5": "플레이오프", "7": "한국시리즈", "1": "시범경기", "9": "올스타전" } as Record<string, string>)[srId];
  return {
    regular,
    label: label ? `${label} 경기입니다.` : null,
    instructions: regular ? "" : `\n## 최우선 경기 구분 규칙\n이 경기는 ${label ?? "정규시즌 외"} 경기입니다. 위 정규시즌 시리즈·순위 관련 예시와 지시를 적용하지 마세요. 정규시즌 순위·승차·승률에 영향을 주지 않습니다. 순위 경쟁, 자리 굳히기, 승차 벌리기, 위닝시리즈·스윕을 모든 필드에서 언급하지 마세요. standingsImpact와 seriesContext는 null로 출력하세요. 별도 래더 확정 사실이 있을 때만 해당 정보를 신뢰하세요. 진출·탈락·우승 확정이나 시리즈 종료/리드/전적을 추정하지 마세요. insight와 headline은 이 경기의 점수·박스스코어 사실만 설명하세요.\n`,
  };
}

/** Reject leaked regular-season/unsupported qualification claims anywhere in the narrative. */
export function invalidPostseasonNarrative(summary: Record<string, unknown>, facts: string | null = null): boolean {
  const values: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") values.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit({ ...summary, seriesContext: null, standingsImpact: null });
  if (values.some(text => /순위|승차|승률|[1-9]위|위닝\s*시리즈|스윕/.test(text))) return true;
  // Qualification/series claims are allowed only as a supplied canonical clause,
  // not merely because they contain an allowed keyword or winning team's name.
  const normalize = (text: string) => text.replace(/(?:은|는|이|가|을|를)(?=\s)|(?:했습니다|했다|한다|됐다)|[\s.,·]/g, "");
  const evidence = facts?.split(/[.,]/).map(normalize).filter(Boolean) ?? [];
  return values.some(text => text.split(/[.,!?\n]/).some(clause => {
    if (!/진출|탈락|우승|시즌\s*종료|시리즈.{0,30}(?:승|패|무|리드|마쳤|종료)/.test(clause)) return false;
    const claim = normalize(clause);
    return !evidence.some(fact => fact === claim);
  }));
}

export function summaryCompetitionInstructions(srId: string, facts: string | null): string {
  const policy = summaryCompetitionPolicy(srId);
  if (policy.regular) return "";
  return policy.instructions + (facts ? `\n## 이 경기 종료 시점의 래더 확정 사실\n${facts}\n위 사실은 별도 시리즈 필드에 그대로 표시됩니다. 다른 필드에서 진출·전적을 언급할 경우 위 확정 사실의 해당 문장을 그대로 사용하세요. 새 해석이나 반대 결과를 만들지 마세요.\n` : "\n래더 사실 조회 불가: 누적 전적·진출 결과를 추정하지 마세요.\n");
}
