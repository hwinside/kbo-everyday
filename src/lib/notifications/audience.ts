import { fetchAllByKeyset } from "@/lib/db/paginate";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { runBeforeDeadline } from "@/lib/async-deadline";

interface ProfileIdRow {
  id: string;
}

async function fetchProfileIds(
  label: string,
  buildQuery: (cursor: string | null, limit: number) => Promise<{
    data: ProfileIdRow[] | null;
    error: { message: string } | null;
  }>,
): Promise<string[]> {
  const rows = await fetchAllByKeyset(buildQuery, (row) => row.id, { label });
  return rows.map((row) => row.id);
}

export function fetchTeamFanIds(teamIds: number[], opts?: { deadlineAtMs?: number }): Promise<string[]> {
  if (teamIds.length === 0) return Promise.resolve([]);
  return fetchProfileIds("team fans", async (cursor, limit) => {
    const remainingMs = opts?.deadlineAtMs == null ? null : opts.deadlineAtMs - Date.now();
    if (remainingMs != null && remainingMs <= 0) throw new Error("team fans: deadline_exceeded");
    let query = supabase
      .from("profiles")
      .select("id")
      .in("team_id", teamIds)
      .order("id", { ascending: true })
      .limit(limit);
    if (cursor !== null) query = query.gt("id", cursor);
    if (remainingMs != null) query = query.abortSignal(AbortSignal.timeout(Math.max(1, remainingMs)));
    const { data, error } = await runBeforeDeadline(() => query, opts?.deadlineAtMs);
    return { data: data as ProfileIdRow[] | null, error };
  });
}

export function fetchFavoritePlayerFanIds(kboId: string): Promise<string[]> {
  return fetchProfileIds(`favorite player fans (${kboId})`, async (cursor, limit) => {
    let query = supabase
      .from("profiles")
      .select("id")
      .contains("favorite_players", JSON.stringify([{ playerId: kboId }]))
      .order("id", { ascending: true })
      .limit(limit);
    if (cursor !== null) query = query.gt("id", cursor);
    const { data, error } = await query;
    return { data: data as ProfileIdRow[] | null, error };
  });
}
