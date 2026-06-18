const STORAGE_KEY = "kbo-favorite-players";

export interface FavoritePlayer {
  playerId: string;
  name: string;
  teamId: number;
  position: string;
  number: number;
}

export interface FavoritePlayerSource {
  id: string;
  name: string;
  teamId: number;
  position?: string;
  backNo?: string;
}

export function getFavoritePlayers(): FavoritePlayer[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch { return []; }
}

export function buildFavoritePlayersInSelectionOrder(
  selectedIds: Iterable<string>,
  players: FavoritePlayerSource[],
): FavoritePlayer[] {
  const byId = new Map(players.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const favs: FavoritePlayer[] = [];

  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    const player = byId.get(id);
    if (!player) continue;

    favs.push({
      playerId: player.id,
      name: player.name,
      teamId: player.teamId,
      position: player.position || "",
      number: player.backNo ? parseInt(player.backNo, 10) || 0 : 0,
    });
  }

  return favs;
}

export function setFavoritePlayers(players: FavoritePlayer[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(players.slice(0, 5)));
}

export function clearFavoritePlayers(): void {
  localStorage.removeItem(STORAGE_KEY);
}
