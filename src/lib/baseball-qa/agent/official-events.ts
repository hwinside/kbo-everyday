import bundle from "./official-event-evidence.json";
import type { Evidence, SearchRequest } from "./poc";

/** Reviewed snapshots, not live result data. Never backdate newly acquired evidence. */
const kstYear = (now: string) => new Date(Date.parse(now) + 9 * 3_600_000).getUTCFullYear();

export function officialEventRequest(question: string, now: string): SearchRequest | null {
  if (process.env.BASEBALL_GENIUS_OFFICIAL_EVENT_EVIDENCE === "0") return null;
  if (!/아시안\s*게임/u.test(question) || /WBC|프리미어|올림픽|오늘|어제|내년|작년|지난|다음|역대|여자|여성|소프트볼|축구|농구|배구|탁구/iu.test(question)) return null;
  if (!/언제|일정|몇\s*월|몇\s*일|몇칠|기간|개막|명단|엔트리|국가\s*대표.*누구|국대.*누구/u.test(question)) return null;
  if (/명단|엔트리|누구/u.test(question) && /일본|대만|타이완|중국|태국|홍콩|팔레스타인|필리핀/u.test(question)) return null;
  const explicit = question.match(/(?:19|20)\d{2}/g) ?? [];
  const year = explicit.length ? Number(explicit[0]) : kstYear(now);
  if (explicit.some(value => Number(value) !== year)) return null;
  const row = bundle.find(item => item.event === "asian-games" && item.year === year);
  if (!row || !Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(row.capturedAt)) return null;
  return { source: "official", query: question, terms: [`${year} 아시안게임 야구`] };
}

export function officialEventEvidence(request: SearchRequest, now: string): Evidence[] {
  if (request.source !== "official" || !officialEventRequest(request.query, now)) return [];
  // Only the validated query's year, never an arbitrary document/URL supplied by the model.
  const year = Number(request.query.match(/(?:19|20)\d{2}/)?.[0] ?? kstYear(now));
  return bundle.filter(row => row.year === year && Date.parse(row.capturedAt) <= Date.parse(now)).map(row => ({
    id: `official:asian-games:${row.year}:${row.snapshotSha256.slice(0, 24)}`,
    source: "official", title: row.title, content: row.content, url: row.url, asOf: row.capturedAt,
  }));
}
