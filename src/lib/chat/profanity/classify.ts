// P0 순수 분류기. 집행·저장·로깅은 호출하지 않는다.
import { splitWords, normalizeToken } from "./normalize";
import * as R from "./rules";

export interface Match {
  rule: string;
  tier: R.Tier;
  word: string;
  index: number;
  /** 공백 삽입형일 때 끝 어절 순번. 생략하면 index와 동일. */
  endIndex?: number;
  /** 시작/끝 어절 각각의 정규화 UTF-16 구간. 원문 오프셋이 아니다. */
  start: number;
  end: number;
}
export interface Result { verdict: R.Verdict; matches: Match[] }
type Span = { start: number; end: number };
const PRIORITY: Record<R.Verdict, number> = { pass: 0, soft: 1, hard_new: 2, hard_legacy: 3 };
const N = (values: readonly string[]) => values.map(normalizeToken);
const ALLOW = N(R.ALLOWLIST);
const PREFIXES = N(R.HARD_PREFIXES);
const SUFFIXES = N(R.HARD_SUFFIXES);
const POSITIVE = N(R.THREAT_POSITIVE_PREFIX);
const CHEERS = N(R.CHEER_NEXT);
const STATE_SUBJECTS = N(R.STATE_SUBJECTS);
const THREAT_ALLOW = N(R.THREAT_ALLOW_EXACT);
const MICHIN_POSITIVE = N(R.MICHIN_POSITIVE_SUFFIX);

function spans(norm: string, term: string): Span[] {
  if (!term) return [];
  const found: Span[] = [];
  for (let start = norm.indexOf(term); start !== -1; start = norm.indexOf(term, start + 1)) {
    found.push({ start, end: start + term.length });
  }
  return found;
}

/** 같은 rule 문자열을 실제로 포함하는 정상 표현의 구간만 사용한다. */
function isAllowed(norm: string, term: string, candidate: Span, explicit: readonly string[] = []): boolean {
  return [...ALLOW.filter((allow) => allow.includes(term)), ...explicit].some((allow) =>
    spans(norm, allow).some((span) => span.start <= candidate.start && candidate.end <= span.end));
}

function hasBoundary(norm: string, term: string, span: Span): boolean {
  const before = norm.slice(0, span.start);
  const after = norm.slice(span.end);
  // 정상 복합어 바로 옆의 별도 욕설은 검사한다(새끼손가락새끼 등).
  const left = !before || PREFIXES.includes(before) || ALLOW.includes(before) || before === term;
  const right = !after || SUFFIXES.includes(after) || ALLOW.includes(after) || after === term;
  return left && right;
}

export function classify(text: string): Result {
  const words = splitWords(text);
  const matches: Match[] = [];
  let verdict: R.Verdict = "pass";

  // 기존 필터처럼 어절 사이의 공백/기호를 제거한 문장도 검사한다.
  // 위치를 각 어절로 되돌려 면책 및 반환 span을 문장 전체 PASS와 분리한다.
  let length = 0;
  const offsets = words.map((word) => {
    const start = length;
    length += word.norm.length;
    return { word, start, end: length };
  });
  const joined = words.map((word) => word.norm).join("");
  const normalizedOffset = (rawOffset: number) => {
    for (const entry of offsets) {
      if (rawOffset <= entry.word.start) return entry.start;
      if (rawOffset < entry.word.end) {
        return entry.start + normalizeToken(entry.word.raw.slice(0, rawOffset - entry.word.start)).length;
      }
    }
    return length;
  };
  for (const rule of [...R.HARD_LEGACY, R.SAEKKI_RULE]) {
    if (!rule) continue;
    const term = normalizeToken(rule);
    const candidates = spans(joined, term);
    // 현행 raw flexible(글자 사이 0~3자)의 탐지 범위 유지. 짧은 후보부터
    // 수집하여 '시발점시발'에서 정상/욕설 두 구간이 하나로 합쳐지지 않게 한다.
    const pattern = [...rule].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]{0,3}?");
    const flexible = new RegExp(`(?=(${pattern}))`, "giu");
    let rawMatch: RegExpExecArray | null;
    while ((rawMatch = flexible.exec(text)) !== null) {
      candidates.push({ start: normalizedOffset(rawMatch.index), end: normalizedOffset(rawMatch.index + rawMatch[1].length) });
      flexible.lastIndex = rawMatch.index + 1;
    }
    const seen = new Set<string>();
    for (const span of candidates) {
      const key = `${span.start}:${span.end}`;
      if (seen.has(key) || span.end <= span.start) continue;
      seen.add(key);
      if (isAllowed(joined, term, span, N(R.LEGACY_ALLOWLIST[rule] ?? []))) continue;
      const first = offsets.find((entry) => entry.start <= span.start && span.start < entry.end);
      const last = offsets.find((entry) => entry.start < span.end && span.end <= entry.end);
      if (!first || !last) continue;
      // 상태 주어의 바로 다음 '꺼져'만 면책. '꺼져라/꺼져버려'는 명령형.
      if (rule === "꺼져" && first.word.norm === term && first === last
        && STATE_SUBJECTS.includes(words[first.word.index - 1]?.norm ?? "")) continue;
      matches.push({ rule, tier: "hard_legacy", word: text.slice(first.word.start, last.word.end),
        index: first.word.index, ...(first === last ? {} : { endIndex: last.word.index }),
        start: span.start - first.start, end: span.end - last.start });
      verdict = "hard_legacy";
    }
  }
  for (let i = 0; i < words.length; i++) {
    const { raw, norm } = words[i];
    if (!norm) continue;
    const prev = words[i - 1]?.norm ?? "";
    const next = words[i + 1]?.norm ?? "";
    const add = (rule: string, tier: R.Tier, span: Span) => {
      matches.push({ rule, tier, word: raw, index: i, ...span });
      if (PRIORITY[tier] > PRIORITY[verdict]) verdict = tier;
    };
    const literal = (rule: string, tier: R.Tier) => {
      const term = normalizeToken(rule);
      for (const span of spans(norm, term)) {
        if (isAllowed(norm, term, span) || !hasBoundary(norm, term, span)) continue;
        add(rule, tier, span);
      }
    };
    for (const rule of R.HARD_NEW) literal(rule, "hard_new");

    // 입력과 규칙 모두 NFKC 기준. 정상 음절이 섞인 오타는 제외.
    if (R.JAMO_HARD_RE.test(norm)) add("ㅗ", "hard_new", { start: 0, end: norm.length });
    for (const rule of R.THREAT_WORDS) {
      if (!N(R.THREAT_FORMS[rule] ?? []).includes(norm) || THREAT_ALLOW.includes(norm)) continue;
      if (rule === "죽어" && norm === normalizeToken("죽어라") && CHEERS.includes(next)) continue;
      // 긍정 감탄 면책은 죽어/뒤져에만 적용, '좋아 닥쳐' 등을 면책하지 않는다.
      if ((rule === "죽어" || rule === "뒤져") && POSITIVE.includes(prev)) continue;
      if (rule === "죽어" && STATE_SUBJECTS.includes(prev)) continue;
      add(rule, "hard_new", { start: 0, end: norm.length });
    }
    for (const rule of R.SOFT_WORDS) {
      const term = normalizeToken(rule);
      for (const span of spans(norm, term)) {
        if (isAllowed(norm, term, span) || !hasBoundary(norm, term, span)) continue;
        if (rule === "미친" && MICHIN_POSITIVE.some((p) => next.startsWith(p))) continue;
        add(rule, "soft", span);
      }
    }
  }
  return { verdict, matches };
}
