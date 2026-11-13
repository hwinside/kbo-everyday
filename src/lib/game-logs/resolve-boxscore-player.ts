import roster from "@/lib/constants/players-roster.json";
import { canonicalKboId, resolvePlayer } from "@/lib/utils/resolve-player";
import type { RosterPlayer } from "@/types/api";

/** Provider IDs disambiguate same-team, same-role names. Never fall back from a bad ID. */
export function resolveBoxscorePlayer(q: { name: string; teamId: number; sourceId?: unknown }) {
  if (q.sourceId == null || q.sourceId === "") {
    // Legacy fixtures/providers without IDs retain the existing unique-name guard.
    return resolvePlayer({ name: q.name, teamId: q.teamId });
  }
  if (typeof q.sourceId !== "string" && typeof q.sourceId !== "number") return null;
  const id = String(q.sourceId).trim();
  if (!/^\d{5}$/.test(id)) return null;
  const canonical = canonicalKboId(id);
  const candidates = (roster as RosterPlayer[]).filter(
    (p) => p.kboId === canonical && p.teamId === q.teamId,
  );
  if (candidates.length !== 1) return null;
  // Verify name too, preserving registered foreign-name/alias normalization.
  // Batting is not a roster position: a pitcher can legitimately have a batting row.
  return resolvePlayer({ name: q.name, teamId: q.teamId }, candidates);
}
