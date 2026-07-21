export interface SupabaseBackup {
  id?: number | string;
  inserted_at?: string;
  status?: string;
  is_physical_backup?: boolean;
}

const MAX_BACKUP_AGE_MS = 30 * 60 * 60 * 1000;

export function selectFreshPhysicalBackup(
  backups: SupabaseBackup[],
  nowMs = Date.now(),
): Required<Pick<SupabaseBackup, "id" | "inserted_at">> | null {
  const candidates = backups.flatMap((backup) => {
    if (backup.status !== "COMPLETED" || backup.is_physical_backup !== true) return [];
    if (backup.id == null || !backup.inserted_at) return [];
    const insertedAt = Date.parse(backup.inserted_at);
    const age = nowMs - insertedAt;
    if (!Number.isFinite(insertedAt) || age < -5 * 60 * 1000 || age > MAX_BACKUP_AGE_MS) return [];
    return [{ id: backup.id, inserted_at: backup.inserted_at, insertedAt }];
  });
  candidates.sort((a, b) => b.insertedAt - a.insertedAt);
  const latest = candidates[0];
  return latest ? { id: latest.id, inserted_at: latest.inserted_at } : null;
}

export function physicalBackupRef(backup: Required<Pick<SupabaseBackup, "id" | "inserted_at">>): string {
  return `supabase-physical:${backup.id}@${backup.inserted_at}`;
}
