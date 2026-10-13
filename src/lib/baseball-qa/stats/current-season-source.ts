import { fetchServedCareerSnapshot } from "./served-record";
import type { SeasonRecordRow } from "./season-record";

type Table = "batter" | "pitcher";
type Snapshot = { rows: SeasonRecordRow[]; updatedAt: string };

/** Request-scoped app snapshot: one fetch per source, including rejected fetches.
 * Never fall back to the daily DB snapshot; its update cadence differs from /api/stats.
 * The served loader validates the envelope/full roster; resolveSeasonRecord validates
 * exact identity, team, timestamp and each raw metric before answering.
 */
export function createCurrentSeasonRecordFetcher(
  load: (table: Table) => Promise<Snapshot> = fetchServedCareerSnapshot,
): (table: Table, kboId: string) => Promise<SeasonRecordRow[]> {
  const snapshots = new Map<Table, Promise<Snapshot>>();
  return async (table, kboId) => {
    if (!snapshots.has(table)) snapshots.set(table, load(table));
    const snapshot = await snapshots.get(table)!;
    // Preserve duplicates for the final validator; never select a first/name match.
    return snapshot.rows.filter((row) => row.kbo_id === kboId);
  };
}
