export interface PitcherFact { name: string; ip: string; r: number; er: number }
interface RecordInput {
  awayTeam: string; homeTeam: string; awayScore: number; homeScore: number;
  linescore?: { away: { innings: (number | null)[] }; home: { innings: (number | null)[] } };
}
function prose(value: unknown, subject = ''): string[] {
  if (typeof value === 'string') return [subject ? `${subject} ${value}` : value];
  if (Array.isArray(value)) return value.flatMap(item => prose(item, subject));
  if (!value || typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : subject;
  return Object.entries(obj).filter(([key]) => !key.startsWith('_')).flatMap(([, item]) => prose(item, name));
}
/** Conservatively reject shutout claims bound to a pitcher who allowed runs. */
export function hasFalseShutoutClaim(summary: unknown, pitchers: PitcherFact[]): boolean {
  const texts = prose(summary);
  return pitchers.some(p => p.r > 0 && texts.some(text => text.includes(p.name) &&
    (/무실점|실점\s*없이|(?:단\s*)?(?:1|한)\s*점도\s*(?:내주지|허용하지)|(?:0|영)\s*실점/.test(text))));
}

export function hasFalsePitcherInnings(summary: unknown, pitchers: PitcherFact[]): boolean {
  return pitchers.some(p => prose(summary).some(text => text.includes(p.name) &&
    [...text.matchAll(/(\d+(?:\.[012])?)\s*이닝/g)].some(match =>
      /^\d+(?:\.[012])?$/.test(p.ip.trim()) && Number(match[1]) !== Number(p.ip))));
}
export function hasVerifiedPitcherClaims(summary: Record<string, unknown>): boolean {
  const facts = summary._verifiedPitcherFacts;
  return Array.isArray(facts) && facts.every(p => p && typeof p.name === 'string' &&
    typeof p.ip === 'string' && Number.isFinite(p.r) && p.r >= 0 && Number.isFinite(p.er) && p.er >= 0)
    && !hasFalseShutoutClaim(summary, facts) && !hasFalsePitcherInnings(summary, facts);
}
/** No player/inning guesses, causal claims, or external model dependency. */
export function buildRecordSummary(input: RecordInput): Record<string, unknown> {
  const { awayTeam, homeTeam, awayScore, homeScore } = input;
  const result = awayScore === homeScore ? `${awayTeam}와 ${homeTeam}, ${awayScore}:${homeScore} 무승부`
    : awayScore > homeScore ? `${awayTeam}, ${homeTeam}에 ${awayScore}:${homeScore} 승리`
      : `${homeTeam}, ${awayTeam}에 ${homeScore}:${awayScore} 승리`;
  const flow = (start: number, end: number) => {
    if (!input.linescore) return '';
    const total = (side: 'away' | 'home') => input.linescore![side].innings.slice(start - 1, end)
      .reduce<number>((sum, runs) => sum + (runs ?? 0), 0);
    return `${start}~${end}회 득점은 ${awayTeam} ${total('away')}점, ${homeTeam} ${total('home')}점입니다.`;
  };
  return {
    headline: result, insight: `최종 스코어는 ${awayTeam} ${awayScore}점, ${homeTeam} ${homeScore}점입니다.`,
    gameFlow: { early: flow(1, 3), mid: flow(4, 6), late: flow(7, 9) },
    turningPoint: '', summaryKind: 'record',
  };
}
