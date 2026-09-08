import { canonicalKboId } from "../../utils/resolve-player";

/** Validated request metadata only: never persisted answers or evidence values. */
export interface RankRequestContext {
  version: 1;
  kind: "average_rank";
  playerId?: string;
  teamId?: number;
}

/** The same canonical numeric/foreign ID domain as the served player records. */
export function readRankPlayerId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  const id = canonicalKboId(value);
  return /^(?:\d{1,8}|[A-Z]{2}\d{3})$/.test(id) ? id : undefined;
}

export function readRankRequestContext(value: unknown): RankRequestContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.kind !== "average_rank") return undefined;
  const playerId = readRankPlayerId(row.playerId);
  if (row.playerId !== undefined && playerId === undefined) return undefined;
  if (row.teamId !== undefined && (!Number.isInteger(row.teamId) || Number(row.teamId) < 1 || Number(row.teamId) > 10)) return undefined;
  return { version: 1, kind: "average_rank", ...(playerId !== undefined ? { playerId } : {}),
    ...(typeof row.teamId === "number" ? { teamId: row.teamId } : {}) };
}
