import type { ContextTurn } from "../context";
import { KBO_OFFICIAL_METRIC_TERMS } from "./kbo-official-metric-columns";

// A narrow routing exception, not an answer dictionary. Unknown/ambiguous asks
// keep the existing routes; the model still decides what the evidence supports.
const MEANING_ASK = /뜻|의미|정의|뭘\s*말|무엇을?\s*말|뭐(?:야|예요|에요|지|임|냐|라고)|뭔(?:데|가|지)|무엇|먼데|(?:용어|지표)\s*설명/;
const VALUE_ASK = /몇|얼마|몇\s*위|[0-9]+\s*위|(?:기록|성적|개수|횟수|순위)(?:은|는|이|가)?\s*(?:뭐|뭔|무엇|어때|알려|보여)/;
const REFERENCE_MEANING_ASK = /^(?:(?:아니|아|엉|응|지금|그럼|그러면)[\s?!,.]*)*(?:(?:[0-9]+(?:\.[0-9]+)?)\s*(?:라며|이라며|라고)[\s?!,.]*)?(?:그게|저게|이게|그건|그거|저거|그것|그\s*기록)(?:은|는|이|가)?\s*(?:무슨\s*)?(?:(?:뜻|의미)(?:이야|야|예요|인가요|이냐고|이냐구|인지요?|를?\s*(?:알려줘|설명해줘))?|뭐(?:야|예요|에요|지|냐|라고)|뭔(?:데|가요?|지)|먼데|무엇(?:이야|인가요|인지)?)[\s?!,.]*$/;

function metricTerms(question: string): string[] {
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  // Longest first: '출루율' must not also bind a shorter embedded metric.
  let rest = compact;
  const found: string[] = [];
  for (const term of [...KBO_OFFICIAL_METRIC_TERMS].sort((a, b) => b.length - a.length)) {
    const key = term.toLowerCase();
    // Latin abbreviations must not match arbitrary words (e.g. WAR in software).
    const pattern = /^[a-z+]+$/.test(key)
      ? new RegExp(`(?<![a-z])${key.replace(/[+]/g, "\\+")}(?![a-z])`, "g")
      : new RegExp(key, "g");
    if (pattern.test(rest)) {
      found.push(term);
      rest = rest.replace(pattern, " ");
    }
  }
  return found;
}

export function isStatDefinitionQuestion(question: string): boolean {
  const text = question.normalize("NFKC").toLowerCase();
  return MEANING_ASK.test(text) && !VALUE_ASK.test(text) && metricTerms(text).length > 0;
}

export interface StatDefinitionIntent {
  searchQuestion: string;
  context?: ContextTurn;
}

export function resolveStatDefinitionIntent(
  question: string,
  context: ContextTurn | null = null,
): StatDefinitionIntent | null {
  if (isStatDefinitionQuestion(question)) {
    return { searchQuestion: `${metricTerms(question).join(" ")} 야구 기록 용어 뜻 의미`, context: context ?? undefined };
  }
  // Only an explicit referential meaning question can borrow a topic. Do not
  // scan older turns or infer from an ambiguous answer listing several metrics.
  if (!context || !REFERENCE_MEANING_ASK.test(question.normalize("NFKC").trim())) return null;
  const previousTerms = metricTerms(context.question);
  const terms = previousTerms.length > 0 ? previousTerms : metricTerms(context.answer);
  if (terms.length !== 1) return null;
  return { searchQuestion: `${terms[0]} 야구 기록 용어 뜻 의미`, context };
}
