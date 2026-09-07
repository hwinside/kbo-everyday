/** Validated request metadata only: never persisted answers or evidence values. */
export interface RankRequestContext {
  version: 1;
  kind: "average_rank";
  playerId?: string;
  teamId?: number;
}

export function readRankRequestContext(value: unknown): RankRequestContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.kind !== "average_rank") return undefined;
  if (row.playerId !== undefined && (typeof row.playerId !== "string" || !/^\d{1,8}$/.test(row.playerId))) return undefined;
  if (row.teamId !== undefined && (!Number.isInteger(row.teamId) || Number(row.teamId) < 1 || Number(row.teamId) > 10)) return undefined;
  return { version: 1, kind: "average_rank", ...(typeof row.playerId === "string" ? { playerId: row.playerId } : {}),
    ...(typeof row.teamId === "number" ? { teamId: row.teamId } : {}) };
}
