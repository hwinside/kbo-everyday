const STORAGE_KEY = "kbo-favorite-players";

export interface FavoritePlayer {
  playerId: string;
  name: string;
  teamId: number;
  position: string;
  number: number;
}

export function getFavoritePlayers(): FavoritePlayer[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch { return []; }
}

export function setFavoritePlayers(players: FavoritePlayer[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(players.slice(0, 5)));
}

export function clearFavoritePlayers(): void {
  localStorage.removeItem(STORAGE_KEY);
}
