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

const regularClaim = /순위|승차|승률|[1-9]위|위닝\s*시리즈|스윕/;
const canonicalRounds = (text: string) => text.replace(/준플레이오프/gi, "준PO").replace(/플레이오프/gi, "PO").replace(/코리안\s*시리즈|KS/gi, "한국시리즈");

/** Compare the claim's subject, destination and counts, never whole-sentence wording. */
function invalidSentence(text: string, facts: string | null): boolean {
  if (regularClaim.test(text)) return true;
  const evidence = canonicalRounds(facts ?? "");
  const sentence = canonicalRounds(text);
  const teams = [...evidence.matchAll(/([^\s:·]+) (\d+)승/g)].map(m => ({ name: m[1], wins: Number(m[2]) }));
  const result = evidence.match(/([^\s.,]+) (준PO|PO|한국시리즈) (진출|우승) 확정/);
  const loser = evidence.match(/([^\s.,]+) 시즌 종료/)?.[1];
  const draws = Number(evidence.match(/(\d+)무/)?.[1]);
  // Clauses can contain both a winner's advancement and a loser's elimination.
  let carriedSubject: string | undefined;
  for (const clause of sentence.split(/[,;]|(?:하며|했고|하고)\s+/)) {
    const mentions = [...clause.matchAll(/진출|탈락|우승|시즌\s*종료/g)];
    for (const mention of mentions) {
      if (!result) return true;
      const before = clause.slice(0, mention.index);
      const eliminated = /탈락|시즌/.test(mention[0]);
      const expected = eliminated ? loser : result[1];
      // Opponent objects ("두산을 꺾고", "두산 꺾고") aren't the advancing subject.
      const subjects = teams.filter(t => before.includes(t.name) && !new RegExp(`${t.name}(?:을|를)?\\s*(?:꺾|제압|물리|상대로|에(?:게)?\\s*승리)`).test(before));
      const subject = subjects.sort((a, b) => before.lastIndexOf(b.name) - before.lastIndexOf(a.name))[0]?.name ?? carriedSubject;
      if (subject && subject !== expected) return true;
      const destination = [...before.matchAll(/준PO|(?<!준)PO|한국시리즈/g)].at(-1)?.[0];
      if (!eliminated && destination && destination !== result[2]) return true;
      if (!eliminated && (mention[0] === "우승") !== (result[3] === "우승")) return true;
    }
    const named = teams.filter(t => clause.includes(t.name) && !new RegExp(`${t.name}(?:을|를)?\\s*(?:꺾|제압|물리|상대로|에(?:게)?\\s*승리)`).test(clause));
    carriedSubject = named.sort((a, b) => clause.lastIndexOf(b.name) - clause.lastIndexOf(a.name))[0]?.name ?? carriedSubject;
    // Counts refer to the series only when explicitly labelled or attached to a team.
    if (/시리즈|전적|누적/.test(clause) || teams.some(t => new RegExp(`${t.name}.*\\d+승`).test(clause))) {
      const counts = [...clause.matchAll(/(\d+)\s*([승패무])/g)];
      if (counts.length && !teams.length) return true;
      for (const count of counts) {
        const prefix = clause.slice(0, count.index);
        const subject = teams.filter(t => prefix.includes(t.name)).sort((a, b) => prefix.lastIndexOf(b.name) - prefix.lastIndexOf(a.name))[0];
        const expected = count[2] === "무" ? draws : subject
          ? count[2] === "승" ? subject.wins : teams.find(t => t.name !== subject.name)?.wins
          : undefined;
        if (expected === undefined || Number(count[1]) !== expected) return true;
      }
    }
  }
  return false;
}

const sentences = (text: string) => text.match(/(?:[^.!?\n]|(?<=\d)\.(?=\d))+[.!?]?\s*/g) ?? [];

/** Structured series/standings fields are assigned from trusted evidence by the route. */
export function invalidPostseasonNarrative(summary: Record<string, unknown>, facts: string | null = null): boolean {
  const visit = (value: unknown): boolean => typeof value === "string"
    ? sentences(value).some(sentence => invalidSentence(sentence, facts))
    : !!value && typeof value === "object" && Object.values(value).some(visit);
  return visit({ ...summary, seriesContext: null, standingsImpact: null });
}

/** On the final attempt preserve game analysis, removing only offending sentences. */
export function sanitizePostseasonNarrative(summary: Record<string, unknown>, facts: string | null): void {
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return sentences(value).filter(sentence => !invalidSentence(sentence, facts)).join("").trim();
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  for (const key of Object.keys(summary)) {
    if (key !== "seriesContext" && key !== "standingsImpact") summary[key] = clean(summary[key]);
  }
}

export function summaryCompetitionInstructions(srId: string, facts: string | null): string {
  const policy = summaryCompetitionPolicy(srId);
  if (policy.regular) return "";
  return policy.instructions + (facts ? `\n## 이 경기 종료 시점의 래더 확정 사실\n${facts}\n위 사실은 별도 시리즈 필드에 그대로 표시됩니다. 다른 필드에서 진출·전적을 언급할 경우 위 확정 사실의 팀·라운드·전적을 유지하세요. 준PO/준플레이오프 등 같은 의미의 표현은 허용됩니다. 새 해석이나 반대 결과를 만들지 마세요.\n` : "\n래더 사실 조회 불가: 누적 전적·진출 결과를 추정하지 마세요.\n");
}
