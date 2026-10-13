// 크관 채팅 비속어 필터 — 공개 API (채팅 전용, 순수)
// 공용 moderation/content-filter 와 분리(타 UGC 비회귀).
export { classify, type Result, type Match } from "./classify";
export {
  type Tier,
  type Verdict,
  HARD_LEGACY,
  HARD_NEW,
  SAEKKI_RULE,
  THREAT_WORDS,
  SOFT_WORDS,
  ALLOWLIST,
} from "./rules";
export { normalizeToken, splitWords, type Word } from "./normalize";
