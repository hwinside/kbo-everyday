import { normalizeKey, originalSpellingScope } from "../normalize";

export type ReferentGlossary = ReadonlyArray<{ term: string; aliases: readonly string[] }>;

/** A veto, not a definition router or an alias generator. Only an explicit
 * definition subject (the existing normalizer's literal prefix) or a bare
 * lexical token participates. Retrieval alone cannot promote a component into
 * a reviewed compound. Never infer equivalence from a proper substring.
 *
 * This deliberately conservative boundary also rejects unsolicited compound
 * examples in these short definitions. It does not prove semantic correctness
 * or cover compounds absent from the reviewed glossary.
 */
export function hasUnrequestedCompound(
  question: string,
  answer: string,
  glossary: ReferentGlossary,
  previousQuestion?: string,
): boolean {
  const scope = originalSpellingScope(question);
  const bare = /^[\p{L}\p{N}]+[?!.]*$/u.test(question.trim());
  if (scope === question && !bare) return false;
  const parts = scope.match(/[\p{L}\p{N}]+/gu) ?? [];
  const questionKey = normalizeKey(question);
  const previousKey = normalizeKey(previousQuestion ?? "");
  const answerKey = normalizeKey(answer);
  return glossary.some(entry => {
    const aliases = [entry.term, ...entry.aliases].map(normalizeKey).filter(Boolean);
    // A complete, reviewed spelling in the user turn licenses this referent.
    // Previous bot prose and retrieved documents never license it.
    if (aliases.some(alias => questionKey.includes(alias) || (bare && previousKey.includes(alias)))) return false;
    const component = parts.some(part => {
      const key = normalizeKey(part);
      // Single letters/syllables are not enough to establish a component.
      return [...key].length >= 2 && aliases.some(alias => alias !== key && alias.includes(key));
    });
    return component && aliases.some(alias => answerKey.includes(alias));
  });
}
