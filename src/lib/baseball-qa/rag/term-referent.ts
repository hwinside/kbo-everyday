import { normalizeKey, originalSpellingScope } from "../normalize";

/** A candidate/retrieval-blind interpretation, not a reviewed dictionary fact.
 * Only an ordinary single-word sense can bind an answer; sport-specific names,
 * conventional abbreviations, uncertain and non-definition requests abstain.
 */
export interface IndependentSubject { quote: string; meaning: string }

export function readIndependentSubject(question: string, raw: unknown): IndependentSubject | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  if (row.kind !== "ordinary" || typeof row.quote !== "string" || typeof row.meaning !== "string") return undefined;
  const quote = row.quote.trim();
  const meaning = row.meaning.trim();
  if (!/^[\p{L}]+$/u.test(quote) || quote.length < 2 || quote.length > 40
    || originalSpellingScope(question).replace(/[?!.]+$/u, "").trim() !== quote
    || meaning.length < 1 || meaning.length > 60
    || /[<>`\[\]{}\n\r\u0000-\u001f]|https?:|www\.|\d/iu.test(meaning)) return undefined;
  return { quote, meaning };
}

/** Resolve lexical scope from reviewed canonical spellings, not model labels.
 * A standalone orthographic component of a spaced term is not the whole term.
 * A prefix inside an unspaced canonical word may be an abbreviation: abstain
 * from imposing an ordinary-language sense, without declaring that sense correct.
 * Aliases cannot erase canonical word boundaries by removing spaces.
 */
export function resolveIndependentSubject(
  question: string, blind: IndependentSubject | undefined,
  previousQuestion: string | undefined,
  glossary: ReadonlyArray<{ term: string; aliases: readonly string[] }>,
): IndependentSubject | undefined {
  const quote = originalSpellingScope(question).replace(/[?!.]+$/u, "").trim();
  if (!/^[\p{L}]{2,40}$/u.test(quote)) return undefined;
  const key = normalizeKey(quote);
  const exact = glossary.some(entry => [entry.term, ...entry.aliases].some(value => normalizeKey(value) === key));
  if (exact) return undefined;
  const component = glossary.some(entry => {
    const words = entry.term.trim().split(/\s+/u);
    return words.length > 1 && words.some(word => normalizeKey(word) === key);
  });
  const possibleAbbreviation = glossary.some(entry => !/\s/u.test(entry.term.trim())
    && normalizeKey(entry.term) !== key && normalizeKey(entry.term).startsWith(key));
  if (!component && possibleAbbreviation) return undefined;
  // Empty meaning is intentional: lexical boundaries supply no definition.
  const subject = blind ?? (component ? { quote, meaning: "" } : undefined);
  return contextualSubject(question, subject, previousQuestion, glossary);
}

/** Only a bare follow-up after an explicit reviewed full term may set aside
 * the independent word reading. Prior assistant text never licenses expansion.
 */
export function contextualSubject(
  question: string, subject: IndependentSubject | undefined,
  previousQuestion: string | undefined,
  glossary: ReadonlyArray<{ term: string; aliases: readonly string[] }>,
): IndependentSubject | undefined {
  if (!subject) return undefined;
  if (normalizeKey(question).replace(/[?!.]+$/u, "") !== normalizeKey(subject.quote)) return subject;
  const previous = normalizeKey(previousQuestion ?? "");
  const component = normalizeKey(subject.quote);
  const hasFullContext = glossary.some(entry => [entry.term, ...entry.aliases].some(value => {
    const key = normalizeKey(value);
    return key !== component && key.includes(component) && previous.includes(key);
  }));
  return hasFullContext ? undefined : subject;
}

/** Bind BOTH the declared subject and actual first clause to the independent
 * quote. Meaning is a fallible hint, never a literal substring requirement. No answer rewriting,
 * no whole-answer compound ban. A wrong blind interpretation remains possible.
 */
export function acceptsIndependentSubject(
  row: Record<string, unknown>, subject: IndependentSubject | undefined,
): boolean {
  if (!subject) return true;
  if (row.status !== "GENERAL" || row.subject !== subject.quote || typeof row.answer !== "string") return false;
  const answer = row.answer.trim();
  if (!answer.startsWith(subject.quote)) return false;
  const tail = answer.slice(subject.quote.length);
  if (!/^\s*(?:은|는|이란|란|이라는|라는|:)/u.test(tail)) return false;
  return true;
}
