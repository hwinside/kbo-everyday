// 크관 채팅 비속어 필터 — 핵심 판정 (순수 함수)
// 오탐 최소화: 기본값 PASS. allowlist 는 어절(span) 단위로만 면책하고
// 나머지 어절·다른 rule 은 계속 검사한다(전체 PASS 우회 금지).

import { splitWords, normalizeToken, type Word } from "./normalize";
import * as R from "./rules";

export interface Match {
  rule: string;
  tier: R.Tier;
  /** 매칭된 어절 원문 */
  word: string;
  /** 어절 순번 */
  index: number;
}

export interface Result {
  verdict: R.Verdict;
  matches: Match[];
}

const TIER_PRIORITY: Record<R.Verdict, number> = {
  pass: 0,
  soft: 1,
  hard_new: 2,
  hard_legacy: 3,
};

// NFKC 는 호환 자모(ㅈ/ㅆ 등)를 초성 자모로 바꾸므로, rule 도 어절과 같은
// 정규화를 거쳐 비교해야 자모형 금칙어(ㅅㅂ/ㅈㄴ/ㅆ벌)가 매칭된다.
const N = (arr: readonly string[]): string[] => arr.map(normalizeToken);
const HARD_LEGACY_N = R.HARD_LEGACY.map((r) => [r, normalizeToken(r)] as const);
const HARD_NEW_N = R.HARD_NEW.map((r) => [r, normalizeToken(r)] as const);
const SOFT_WORDS_N = R.SOFT_WORDS.map((r) => [r, normalizeToken(r)] as const);
const SAEKKI_N = normalizeToken(R.SAEKKI_RULE);
const ALLOWLIST_N = N(R.ALLOWLIST);
const THREAT_N = R.THREAT_WORDS.map((r) => [r, normalizeToken(r)] as const);
const THREAT_ALLOW_EXACT_N = N(R.THREAT_ALLOW_EXACT);
const THREAT_POSITIVE_PREFIX_N = N(R.THREAT_POSITIVE_PREFIX);
const MICHIN_POSITIVE_N = N(R.MICHIN_POSITIVE_SUFFIX);
const MICHIN_N = normalizeToken("미친");

/**
 * 어절(norm)이 allowlist 항목으로 커버되면서 그 항목이 rule 을 포함하면 면책.
 * "동일 rule 의 겹치는 span 만 무효화" 계약 — 다른 어절/다른 rule 에는 영향 없음.
 */
function isAllowlisted(norm: string, coveringRuleN: string): boolean {
  for (const allow of ALLOWLIST_N) {
    if (norm.includes(allow) && allow.includes(coveringRuleN)) return true;
  }
  return false;
}

function pushHighest(current: R.Verdict, tier: R.Tier): R.Verdict {
  return TIER_PRIORITY[tier] > TIER_PRIORITY[current] ? tier : current;
}

export function classify(text: string): Result {
  const words: Word[] = splitWords(text);
  const matches: Match[] = [];
  let verdict: R.Verdict = "pass";

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const norm = w.norm;
    if (!norm) continue;

    // --- HARD_LEGACY (즉시 enforce) ---
    for (const [rule, ruleN] of HARD_LEGACY_N) {
      if (norm.includes(ruleN) && !isAllowlisted(norm, ruleN)) {
        matches.push({ rule, tier: "hard_legacy", word: w.raw, index: i });
        verdict = pushHighest(verdict, "hard_legacy");
      }
    }
    // "새끼" 어절 경계 규칙 (allowlist 로 새끼손가락 등 면책)
    if (norm.includes(SAEKKI_N) && !isAllowlisted(norm, SAEKKI_N)) {
      matches.push({ rule: R.SAEKKI_RULE, tier: "hard_legacy", word: w.raw, index: i });
      verdict = pushHighest(verdict, "hard_legacy");
    }

    // --- HARD_NEW (신규, 배포 시 shadow) ---
    for (const [rule, ruleN] of HARD_NEW_N) {
      if (norm.includes(ruleN) && !isAllowlisted(norm, ruleN)) {
        matches.push({ rule, tier: "hard_new", word: w.raw, index: i });
        verdict = pushHighest(verdict, "hard_new");
      }
    }
    // 의도적 자모 ㅗ (단독/반복만)
    if (R.JAMO_HARD_RE.test(norm)) {
      matches.push({ rule: "ㅗ", tier: "hard_new", word: w.raw, index: i });
      verdict = pushHighest(verdict, "hard_new");
    }
    // 위협 어형 — 긍정 문맥/응원 구호는 면책
    for (const [threat, threatN] of THREAT_N) {
      if (!norm.includes(threatN)) continue;
      if (THREAT_ALLOW_EXACT_N.includes(norm)) continue; // 죽어라/죽여주네 등
      const prev = words[i - 1]?.norm ?? "";
      const prevPositive = THREAT_POSITIVE_PREFIX_N.some((p) => prev.includes(p));
      if (prevPositive) continue; // 귀여워 죽어 등
      matches.push({ rule: threat, tier: "hard_new", word: w.raw, index: i });
      verdict = pushHighest(verdict, "hard_new");
    }

    // --- SOFT 문맥어 (shadow, 유저 차단 아님) ---
    for (const [rule, ruleN] of SOFT_WORDS_N) {
      if (!norm.includes(ruleN) || isAllowlisted(norm, ruleN)) continue;
      if (ruleN === MICHIN_N) {
        // "미친놈" 은 이미 hard_legacy. 미친 뒤 긍정어면 감탄으로 면책.
        const next = words[i + 1]?.norm ?? "";
        if (next && MICHIN_POSITIVE_N.some((p) => next.includes(p))) continue;
      }
      matches.push({ rule, tier: "soft", word: w.raw, index: i });
      verdict = pushHighest(verdict, "soft");
    }
  }

  return { verdict, matches };
}
