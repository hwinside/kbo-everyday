import { normalizeKey, originalSpellingScope, definitionQuestionSubject } from "../normalize";

/** A candidate/retrieval-blind interpretation, not a reviewed dictionary fact.
 * Only an ordinary single-word sense can bind an answer; sport-specific names,
 * conventional abbreviations, uncertain and non-definition requests abstain.
 */
export interface IndependentSubject {
  quote: string;
  meaning: string;
  /** Reviewed spaced compounds containing this standalone word; not meanings. */
  compounds?: readonly string[];
}

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
  const compounds = glossary.filter(entry => {
    const words = entry.term.trim().split(/\s+/u);
    return words.length > 1 && words.some(word => normalizeKey(word) === key);
  }).map(entry => entry.term);
  const component = compounds.length > 0;
  const possibleAbbreviation = glossary.some(entry => !/\s/u.test(entry.term.trim())
    && normalizeKey(entry.term) !== key && normalizeKey(entry.term).startsWith(key));
  if (!component && possibleAbbreviation) return undefined;
  // Empty meaning is intentional: lexical boundaries supply no definition.
  const subject = component ? { quote, meaning: blind?.meaning ?? "", compounds } : blind;
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
  // A component cannot be defined as its containing reviewed compound, even
  // when the declared/actual subject matches. Later usage examples remain legal.
  const firstSentence = normalizeKey(answer.split(/[.!?。！？]/u, 1)[0]);
  if (subject.compounds?.some(term => firstSentence.includes(normalizeKey(term)))) return false;
  return true;
}

/** Reviewed names that may expand a prefix, never suffix/substring guesses.
 * A name is an allowed referent, not proof that retrieved prose defines it.
 */
export interface DefinitionReferent {
  quote: string;
  expansions: readonly string[];
}

export function resolveDefinitionReferent(
  question: string, glossary: ReadonlyArray<{ term: string; aliases: readonly string[] }>,
): DefinitionReferent | undefined {
  const quote = definitionQuestionSubject(question);
  if (!quote) return undefined;
  const key = normalizeKey(quote);
  const expansions = glossary.filter(entry => !/\s/u.test(entry.term.trim())
    && normalizeKey(entry.term) !== key && normalizeKey(entry.term).startsWith(key))
    .flatMap(entry => [entry.term, ...entry.aliases]);
  return { quote, expansions: [...new Set(expansions)] };
}

/** A single-word definition needs a word-start source anchor. Containing a
 * suffix (e.g. quota inside a longer compound) is not a definition of the suffix.
 * Korean particles may follow the surface; arbitrary compound continuations
 * must instead be supplied as reviewed full-name expansions.
 * This is lexical relevance, NOT semantic entailment.
 */
export function hasDefinitionAnchor(content: string, referent: DefinitionReferent): boolean {
  const surfaces = [referent.quote, ...referent.expansions];
  return surfaces.some(surface => {
    const literal = surface.normalize("NFKC").trim().split(/\s+/u)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${literal}(?=$|[^\\p{L}\\p{N}]|(?:은|는|이|가|을|를|의|와|과|도|만|부터|까지|에게|에서|에|로|으로|란|이라|라고|다|이다|이며|이고|입니다)(?:는|도|만)?(?:$|[^\\p{L}\\p{N}]))`, "iu")
      .test(content.normalize("NFKC"));
  });
}

/** The model must account for the visible rows before choosing its answer mode.
 * Quote identity and plan/status consistency are deterministic; the claimed
 * semantic relation is NOT. Never promote a rejected answer or retry here.
 * Old stored responses without a plan retain their historical contract.
 */
export function acceptsDefinitionEvidence(
  row: Record<string, unknown>,
  visible: readonly { evidence: number; content: string }[],
  referent?: DefinitionReferent,
): boolean {
  if (row.definitionPlan === undefined) return true;
  if (!Array.isArray(row.definitionEvidence) || row.definitionEvidence.length !== visible.length) return false;
  const seen = new Set<number>();
  const support = new Set<string>();
  for (const raw of row.definitionEvidence) {
    if (!raw || typeof raw !== "object") return false;
    const item = raw as Record<string, unknown>;
    if (typeof item.evidence !== "number" || !Number.isInteger(item.evidence) || seen.has(item.evidence)) return false;
    const source = visible.find(value => value.evidence === item.evidence);
    if (!source || typeof item.quote !== "string") return false;
    seen.add(item.evidence);
    if (item.role === "definition" || item.role === "relation") {
      // Citation is copied from the actual generation input, not raw retrieval.
      if (!item.quote.trim() || !source.content.includes(item.quote)) return false;
      if (referent && !/\s/u.test(referent.quote) && !hasDefinitionAnchor(item.quote, referent)) return false;
      support.add(item.role);
    } else if (item.role !== "mention" && item.role !== "unrelated") return false;
    else if (item.quote !== "") return false;
  }
  switch (row.definitionPlan) {
    case "source_definition": return row.status === "GROUNDED" && support.has("definition");
    case "source_relation": return row.status === "GROUNDED" && support.has("relation");
    case "general_meaning": return row.status === "GENERAL" && support.size === 0;
    case "unknown": return support.size === 0 && ["INSUFFICIENT", "TERM_UNVERIFIED", "TERM_CONTEXTUAL"].includes(String(row.status));
    default: return false;
  }
}

/** No forced subject enum: read the generated referent, then check it. A
 * reviewed prefix expansion may be the actual first subject. Relationship
 * explanations may open with the requested topic, not just a noun definition.
 * Model plan/status labels never waive this first-clause check.
 * Historical rows without subject keep their prior acceptance contract.
 */
export function acceptsDefinitionSubject(
  row: Record<string, unknown>, question: string,
  referent: DefinitionReferent | undefined = resolveDefinitionReferent(question, []),
  evidence?: readonly string[],
): boolean {
  if (!referent || row.subject === undefined) return true;
  if (row.status === "GROUNDED" && !/\s/u.test(referent.quote)
    && evidence && !evidence.some(content => hasDefinitionAnchor(content, referent))) return false;
  const surfaces = [referent.quote, ...referent.expansions];
  if (typeof row.subject !== "string" || !surfaces.some(value => normalizeKey(value) === normalizeKey(row.subject as string))
    || typeof row.answer !== "string") return false;
  const answer = row.answer.trim();
  return surfaces.some(subject => answer.startsWith(subject)
    && /^\s*(?:\([^()\n]{1,60}\)\s*)?(?:은|는|이란|란|이라는|라는|에\s*(?:대해|관해)|의\s*경우|:)/u.test(answer.slice(subject.length)));
}
