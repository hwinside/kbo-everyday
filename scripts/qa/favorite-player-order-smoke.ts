import assert from "node:assert/strict";

import rosterData from "../../src/lib/constants/players-roster.json";
import { buildFavoritePlayersInSelectionOrder } from "../../src/lib/store/favorites";

const roster = rosterData as {
  kboId: string;
  name: string;
  teamId: number;
  position: string;
  backNo: string;
}[];

const allPlayers = roster.map((p) => ({
  id: p.kboId,
  name: p.name,
  teamId: p.teamId,
  position: p.position,
  backNo: p.backNo,
}));

// These LG players appear in roster order as 강민균 -> 강민기 -> 곽민호.
// Selecting them in reverse should persist the user's order, not roster order.
const selected = new Set(["53104", "56102", "53103"]);
const favs = buildFavoritePlayersInSelectionOrder(selected, allPlayers);

assert.deepEqual(
  favs.map((p) => p.playerId),
  ["53104", "56102", "53103"],
);
assert.deepEqual(
  favs.map((p) => p.name),
  ["곽민호", "강민기", "강민균"],
);

console.log("favorite-player-order-smoke: PASS");
