import { isPostseason } from "./crawler/game-series";

export function gameChatLeadHours(srId: unknown): number {
  return isPostseason(srId) ? 24 : 2;
}

export function gameChatOpensAt(startAt: Date | null, srId: unknown): Date | null {
  if (!startAt || !Number.isFinite(startAt.getTime())) return null;
  return new Date(startAt.getTime() - gameChatLeadHours(srId) * 60 * 60 * 1000);
}
