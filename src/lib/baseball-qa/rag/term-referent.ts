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
 * quote, and retain its meaning in the first sentence. No answer rewriting,
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
  const firstSentence = answer.split(/[.!?\n]/u, 1)[0];
  return normalizeKey(firstSentence).includes(normalizeKey(subject.meaning));
}
