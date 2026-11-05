import { createHash } from "node:crypto";

/** Curated source facts, never a title/year heuristic. No match means unknown. */
export function bindCalendarSeasons(doc, documentContentHash, profiles) {
  const profile = profiles.documents.find((entry) => entry.documentContentHash === documentContentHash);
  const bindings = new Map();
  if (!profile) return bindings;
  for (const section of profile.sections) {
    const heading = doc.pages.find((page) => page.page === section.headingPage);
    if (!heading?.text.includes(section.heading)) throw new Error("calendar_season_heading_mismatch");
    if (!Number.isInteger(section.calendarSeason)) throw new Error("calendar_season_invalid");
    for (const target of section.pages) {
      const page = doc.pages.find((candidate) => candidate.page === target.page);
      const hash = page && createHash("sha256").update(page.text).digest("hex");
      if (hash !== target.textSha256 || bindings.has(target.page)) throw new Error("calendar_season_page_mismatch");
      bindings.set(target.page, {
        season: section.calendarSeason,
        axis: "calendar_event",
        heading: section.heading,
        headingPage: section.headingPage,
        pageTextSha256: target.textSha256,
        sourcePdfSha256: profile.sourcePdfSha256,
      });
    }
  }
  return bindings;
}
