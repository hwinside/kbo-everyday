import type { SearchRequest } from "./poc";

/** Explicit current-turn subjects only: never import an old subject from history. */
export function tournamentSearch(question: string): SearchRequest | null {
  const topics = [
    [/아시안\s*게임/iu, "아시안 게임"],
    [/프리미어\s*12/iu, "프리미어 12"],
    [/\bWBC\b/iu, "WBC"],
    [/올림픽/iu, "올림픽"],
  ] as const;
  const terms = topics.filter(([pattern]) => pattern.test(question)).map(([, term]) => term);
  // Comparisons/multiple competitions require the ordinary planner.
  return terms.length === 1 ? { source: "news", query: question, terms } : null;
}

/** Each word must occur, in either order, in title or body. Sanitized filter grammar. */
export function newsTermFilter(term: string): string | null {
  const cleaned = term.replace(/아시안\s*게임/giu, "아시안 게임").replace(/프리미어\s*12/giu, "프리미어 12")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (cleaned.length < 2 || /^(야구|경기|선수|일정|결과|뉴스|최근|오늘)$/u.test(cleaned)) return null;
  const words = [...new Set(cleaned.split(/\s+/u))].slice(0, 8);
  return words.map(word => `or(title.ilike.*${word}*,content.ilike.*${word}*)`).join(",");
}

/** Narrow before LIMIT; broad lane remains available when exact intent is absent. */
export function newsIntentFilter(query: string): string | null {
  const words = /결과|스코어|이겼|졌|승리|패배/u.test(query) ? ["결과", "승리", "패배", "꺾", "승", "패"]
    : /일정|언제|몇\s*월|몇\s*일|몇칠|개막|결승/u.test(query) ? ["일정", "개막", "결승", "시작", "개최", "월", "일"]
    : /명단|누구|선발|엔트리/u.test(query) ? ["명단", "선발", "엔트리", "감독", "발탁"] : [];
  return words.length ? words.flatMap(word => [`title.ilike.*${word}*`, `content.ilike.*${word}*`]).join(",") : null;
}
