import { KBO_OFFICIAL_METRIC_TERMS } from "../stats/kbo-official-metric-columns";

const DIGITS = "일이삼사오육칠팔구";
const SMALL: Record<string, bigint> = { 십: BigInt(10), 백: BigInt(100), 천: BigInt(1000) };
const LARGE: Record<string, bigint> = { 만: BigInt(10000), 억: BigInt(100000000), 조: BigInt(1000000000000) };

/** Positional arithmetic only; not a detector for names or colloquial numbers. */
function cardinalValue(token: string): string | null {
  if (!/[십백천만억조]/.test(token)) return null;
  let total = BigInt(0), section = BigInt(0), digit: bigint | null = null;
  let smallLimit = BigInt(10000), largeLimit = BigInt(10000000000000000);
  for (const char of token) {
    const index = DIGITS.indexOf(char);
    if (index >= 0) {
      if (digit !== null) return null;
      digit = BigInt(index + 1);
    } else if (SMALL[char]) {
      const unit = SMALL[char];
      if (unit >= smallLimit) return null;
      section += (digit ?? BigInt(1)) * unit;
      digit = null;
      smallLimit = unit;
    } else if (LARGE[char]) {
      const unit = LARGE[char];
      if (unit >= largeLimit) return null;
      const coefficient = section + (digit ?? BigInt(0));
      if (coefficient === BigInt(0)) return null;
      total += coefficient * unit;
      section = BigInt(0);
      digit = null;
      smallLimit = BigInt(10000);
      largeLimit = unit;
    } else return null;
  }
  return (total + section + (digit ?? BigInt(0))).toString();
}

export interface SinoKoreanQuantity {
  token: string;
  value: string;
  counter: string;
  index: number;
}

const metricUnits = [...KBO_OFFICIAL_METRIC_TERMS]
  .filter((term) => /^[가-힣]+$/.test(term))
  .sort((a, b) => b.length - a.length).join("|");

/**
 * Explicit cardinal + separated counter, or cardinal + canonical metric label.
 * Generic counters need whitespace: 백일장/만루/천군 are words, not 101장/10000루.
 * No standalone numeral, name dictionary, suffix guessing, or tier2 policy change.
 */
export function sinoKoreanQuantities(text: string, counters: string): SinoKoreanQuantity[] {
  const pattern = new RegExp(
    `(?<![가-힣])([일이삼사오육칠팔구십백천만억조]+)(?:\\s+(${counters}|${metricUnits})|(${metricUnits}))`, "g",
  );
  const result: SinoKoreanQuantity[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = cardinalValue(match[1]);
    if (value !== null) result.push({ token: match[0], value, counter: match[2] ?? match[3], index: match.index });
  }
  return result;
}

export function normalizeSinoKoreanQuantities(text: string, counters: string): string {
  let normalized = text;
  for (const match of sinoKoreanQuantities(text, counters).reverse()) {
    normalized = normalized.slice(0, match.index) + match.value + match.counter
      + normalized.slice(match.index + match.token.length);
  }
  return normalized;
}
