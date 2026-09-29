import { normalizeKey } from "./normalize";

type TermEntry = { term: string; aliases: string[] };

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
  // A known name may be repaired by one same-length character substitution,
  // only when its glossary identity is unique. No insertion/deletion, numeric
  // changes, or short Latin acronym fuzzy-matching is authorized here.
  const nearby = terms.filter(entry => !present(original, entry.keys) && entry.keys.some(key => {
    if (/[^가-힣]/u.test(key) || /[0-9]/.test(key)) return false;
    for (let i = 0; i + key.length <= original.length; i++) {
      const window = original.slice(i, i + key.length);
      if (/[^가-힣]/u.test(window)) continue;
      let different = 0;
      for (let j = 0; j < key.length; j++) if (window[j] !== key[j]) different++;
      if (different === 1) return true;
    }
    return false;
  }));
  return nearby.length === 1 && introduced.every(entry => entry.term === nearby[0].term);
}
