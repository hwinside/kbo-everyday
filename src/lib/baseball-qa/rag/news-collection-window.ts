/** clipDate is the run day; coverage is keyed by articleDate/team, not a cumulative total. */
export function newsCollectionWindow(period: string | null, now = Date.now()) {
  if (period !== null && period !== "yesterday" && period !== "today") return null;
  if (!Number.isFinite(now)) return null;
  const selected = period ?? "yesterday";
  const kst = now + 9 * 60 * 60 * 1000;
  const clipDate = new Date(kst).toISOString().slice(0, 10);
  const articleDate = new Date(kst - (selected === "yesterday" ? 86400000 : 0)).toISOString().slice(0, 10);
  return { period: selected, clipDate, articleDate,
    coverageDetail: `source=news-rag-collect;period=${selected};article_date=${articleDate};snapshot=latest` };
}
