import { normalizeKey } from "./normalize";
import { isTermOriginFollowup, isTermOriginQuestion } from "./term-knowledge";

type Entry = { term: string; aliases: string[]; answer: string };
type VerifiedOrigin = {
  term: string;
  aliases: string[];
  spelling: string;
  explanation: string;
  meaning: string;
  references: string[];
};

/** Reviewed spelling is NOT proof of a historical naming story.
 * Static dictionary extension: no DB migration or model-authored origin field.
 * References substantiate spelling/current meaning only; all history stays unknown.
 */
export const VERIFIED_TERM_ORIGINS: readonly VerifiedOrigin[] = [
  { term: "적시타", aliases: ["적시 안타"], spelling: "適時打",
    explanation: "適(알맞을 적)·時(때 시)·打(칠 타)로 이루어진 한자어입니다.",
    meaning: "주자를 득점시키는 안타를 가리킵니다.",
    references: ["https://namu.wiki/w/적시타"] },
  { term: "불펜", aliases: ["bullpen"], spelling: "bullpen",
    explanation: "영어 bullpen을 옮긴 말입니다.",
    meaning: "구원 투수들이 몸을 푸는 곳 또는 구원 투수진을 가리킵니다.",
    references: ["https://ko.wikipedia.org/wiki/불펜"] },
  { term: "홈런", aliases: ["home run"], spelling: "home run",
    explanation: "영어 home run을 옮긴 말입니다.",
    meaning: "타자가 안타를 쳐 아웃이나 수비 실책 없이 모든 베이스를 돌아 득점하는 것입니다.",
    references: ["https://www.mlb.com/glossary/standard-stats/home-run"] },
  { term: "병살", aliases: ["더블 플레이", "더블플레이"], spelling: "倂殺",
    explanation: "한자 표기는 倂殺입니다.",
    meaning: "하나의 연속된 플레이에서 두 명을 아웃시키는 것입니다.",
    references: ["https://ko.wiktionary.org/wiki/병살"] },
];

// Distinct non-contained identities only: 만루홈런 must not borrow 홈런's
// origin, and a prior question mentioning two terms must not silently pick one.
function uniqueTerm(question: string, entries: Entry[]): Entry | null {
  const text = normalizeKey(question);
  const matches = entries.flatMap(entry => [entry.term, ...entry.aliases].flatMap(name => {
    const key = normalizeKey(name);
    if (key.length < 2) return [];
    const spans: { entry: Entry; start: number; end: number }[] = [];
    for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
      spans.push({ entry, start: at, end: at + key.length });
    }
    return spans;
  }));
  const maximal = matches.filter(m => !matches.some(other => other.start <= m.start && other.end >= m.end
    && other.end - other.start > m.end - m.start));
  const distinct = [...new Map(maximal.map(m => [m.entry.term, m.entry])).values()];
  return distinct.length === 1 ? distinct[0] : null;
}

export function resolveTermOrigin(question: string, glossary: Entry[], priorUserQuestion?: string): {
  question: string; answer: string; term: string | null;
} | null {
  if (!isTermOriginQuestion(question)) return null;
  // Enrich a canonical dictionary entry without treating spelling/history as synonyms.
  const entries = [...glossary];
  for (const origin of VERIFIED_TERM_ORIGINS) {
    const entry = entries.find(e => e.term === origin.term);
    if (entry) entries[entries.indexOf(entry)] = { ...entry, aliases: [...entry.aliases, ...origin.aliases] };
    else entries.push({ term: origin.term, aliases: origin.aliases, answer: origin.meaning });
  }
  const currentKey = normalizeKey(question);
  const hasExplicitTerm = entries.some(entry => [entry.term, ...entry.aliases].some(name => {
    const key = normalizeKey(name);
    return key.length >= 2 && currentKey.includes(key);
  }));
  const topicQuestion = isTermOriginFollowup(question) && !hasExplicitTerm ? priorUserQuestion : question;
  const entry = topicQuestion ? uniqueTerm(topicQuestion, entries) : null;
  if (!entry) return { question, term: null,
    answer: "어떤 야구 용어의 유래를 말씀하시는지 용어를 하나 적어 주세요. 확인되지 않은 원어나 명칭 유래를 추측해 설명하지 않겠습니다." };
  const origin = VERIFIED_TERM_ORIGINS.find(o => o.term === entry.term);
  // 사구 is a homonym (死球 / 四球); never infer either spelling from bare 사구.
  if ([entry.term, ...entry.aliases].some(name => normalizeKey(name) === "사구")
      && normalizeKey(topicQuestion ?? "").includes("사구")) return { question: "사구 유래", term: entry.term,
    answer: "사구는 몸에 맞는 공을 뜻하시는지, 볼넷을 뜻하시는지 먼저 확인이 필요합니다. 어느 뜻인지 알려주시면 확인된 표기와 명칭 유래를 구분해 설명하겠습니다." };
  const currentMeaning = origin?.meaning ?? entry.answer.trim().split(/(?<=[.!?。！？])(?:\s+|$)|\n/u)[0];
  const explanation = origin ? `${entry.term}의 확인된 표기는 ${origin.spelling}입니다. ${origin.explanation} ` : `${entry.term}: `;
  return { question: `${entry.term} 유래`, term: entry.term,
    answer: `${explanation}현재 뜻: ${currentMeaning} 명칭의 역사적 유래는 확인하지 못했습니다.` };
}
