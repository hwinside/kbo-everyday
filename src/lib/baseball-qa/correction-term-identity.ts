import { normalizeKey } from "./normalize";

/** Complete, correctly spelled period-only utterances are not glossary typos.
 * This suppresses spelling correction only; it supplies neither intent, team,
 * context eligibility nor a supported date to the downstream answer path. */
export function isTemporalOnlyUtterance(question: string): boolean {
  return /^(?:(?:그럼|그러면|아니)\s*)?(?:오늘|내일|모레|어제|그제|올해|내년|작년|(?:이번|다음|지난)\s*(?:주|달|시즌))(?:은|는|도)?(?:요)?[\s?!,.…~]*$/u.test(question.normalize("NFKC").trim());
}

type TermEntry = { term: string; aliases: string[] };

// Align the proposed spelling to the original question. A destination term
// must be explained at its edited location, not by an unrelated nearby word.
function originalPositions(original: string, proposed: string): number[] {
  const distance = Array.from({ length: original.length + 1 }, () => new Uint32Array(proposed.length + 1));
  for (let i = 0; i <= original.length; i++) distance[i][0] = i;
  for (let j = 0; j <= proposed.length; j++) distance[0][j] = j;
  for (let i = 1; i <= original.length; i++) {
    for (let j = 1; j <= proposed.length; j++) {
      distance[i][j] = Math.min(
        distance[i - 1][j - 1] + Number(original[i - 1] !== proposed[j - 1]),
        distance[i - 1][j] + 1,
        distance[i][j - 1] + 1,
      );
    }
  }
  const positions = Array<number>(proposed.length).fill(-1);
  let i = original.length;
  let j = proposed.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && distance[i][j] === distance[i - 1][j - 1] + Number(original[i - 1] !== proposed[j - 1])) {
      positions[j - 1] = i - 1;
      i--; j--;
    } else if (i > 0 && distance[i][j] === distance[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  return positions;
}

/** Bound spelling suggestions to glossary identity, not merely a valid destination.
 * This is not a general semantic-equivalence classifier. Non-term requests keep
 * their existing correction policy; this function never auto-accepts a rewrite.
 */
export function preservesCorrectionTermIdentity(question: string, candidate: string, entries: TermEntry[]): boolean {
  const original = normalizeKey(question);
  const proposed = normalizeKey(candidate);
  const terms = entries.map(entry => ({
    term: entry.term,
    keys: [...new Set([entry.term, ...entry.aliases].map(normalizeKey))].filter(key => key.length >= 2),
  }));
  const present = (text: string, keys: string[]) => keys.some(key => text.includes(key));
  const existing = terms.filter(entry => present(original, entry.keys));
  if (existing.some(entry => !present(proposed, entry.keys))) return false;
  const introduced = terms.filter(entry => present(proposed, entry.keys) && !present(original, entry.keys));
  if (introduced.length === 0) return true;
  // Check only identities actually introduced by this candidate. Unchanged
  // question endings and other glossary entries cannot make a repair ambiguous.
  const positions = originalPositions(original, proposed);
  return introduced.every(entry => entry.keys.some(key => {
    if (/[^가-힣]/u.test(key)) return false;
    for (let at = proposed.indexOf(key); at !== -1; at = proposed.indexOf(key, at + 1)) {
      const start = positions[at];
      if (start < 0) continue;
      let different = 0;
      let contiguous = true;
      for (let j = 0; j < key.length; j++) {
        if (positions[at + j] !== start + j || !/[가-힣]/u.test(original[start + j] ?? "")) {
          contiguous = false;
          break;
        }
        if (original[start + j] !== key[j]) different++;
      }
      if (contiguous && different === 1) return true;
    }
    return false;
  }));
}
