/** Reviewed lexical evidence absent from the answer glossary.
 * Veto-only: these entries cannot authorize a correction, route, or answer.
 * Store real dictionary names and provenance, never input→replacement exceptions.
 * Source coverage is intentionally incomplete; model agreement is not proof of safety.
 */
export const CORRECTION_LEXICON = [
  {
    term: "워닝 트랙",
    aliases: ["워닝트랙", "warning track"],
    meaning: "야구장 펜스 앞에서 경기 구역과 재질을 달리하여 펜스 접근을 알리는 구역",
    source: "https://ko.wikipedia.org/wiki/워닝_트랙",
    reviewedAt: "2026-10-02",
  },
] as const;
