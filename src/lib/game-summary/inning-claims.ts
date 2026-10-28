/** Boxscores establish game totals, not which player acted in which inning.
 * Until play-by-play evidence is attached, reject that combination anywhere in
 * one narrative field (including pronoun continuations across sentences).
 */
const INNING = /(?:\d{1,2}\s*회(?:\s*[초말])?|(?:첫|마지막|연장)\s*회|(?:첫|마지막)\s*이닝)/;

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') {
    const subject = 'name' in value && typeof value.name === 'string' ? value.name : '';
    return Object.entries(value).filter(([key]) => !key.startsWith('_'))
      .flatMap(([, child]) => strings(child).map(text => subject ? `${subject} ${text}` : text));
  }
  return [];
}

export function hasUnsupportedPlayerInning(summary: unknown, playerNames: string[]): boolean {
  const names = playerNames.map(name => name.trim()).filter(Boolean);
  return strings(summary).some(text => INNING.test(text) && names.some(name => text.includes(name)));
}

export function hasVerifiedInningClaims(summary: Record<string, unknown>): boolean {
  // The marker must exist so summaries cached before this check are
  // regenerated, but an empty roster is a valid state (see route.ts) and must
  // not permanently hide an otherwise clean summary.
  const names = summary._verifiedPlayerNames;
  return Array.isArray(names) && names.every(n => typeof n === 'string' && n.trim() !== '')
    && !hasUnsupportedPlayerInning(summary, names as string[]);
}
