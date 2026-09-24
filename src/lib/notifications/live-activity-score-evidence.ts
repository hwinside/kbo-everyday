import type { KboRawGame } from "@/types/api";

// Request-local proof: never serialize/reuse it from a DB/cache or attach it to APNs payloads.
// A fresh direct relay and schedule must agree. They are two feeds of the same provider,
// not independent truth; disagreement/fallback therefore keeps the existing retreat guard.
const proofs = new WeakMap<KboRawGame, { snapshot: string; observedAtMs: number }>();
const observations = new WeakMap<KboRawGame, { snapshot: string; observedAtMs: number; directRelay: boolean }>();
export const SCORE_EVIDENCE_MAX_AGE_MS = 30_000;

export function recordLiveScoreObservation(game: KboRawGame, directRelay: boolean, observedAtMs: number): void {
  observations.set(game, { snapshot: snapshot(game), observedAtMs, directRelay });
}

export function liveScoreObservation(game: KboRawGame, nowMs = Date.now()): { observedAtMs: number; freshRelay: boolean } {
  if (!observations.has(game)) recordLiveScoreObservation(game, false, nowMs);
  const observation = observations.get(game)!;
  const age = nowMs - observation.observedAtMs;
  return { observedAtMs: observation.observedAtMs,
    freshRelay: observation.directRelay && age >= 0 && age <= SCORE_EVIDENCE_MAX_AGE_MS &&
      observation.snapshot === snapshot(game) };
}

function snapshot(game: KboRawGame): string {
  return [game.G_ID, game.GAME_STATE_SC, game.T_SCORE_CN, game.B_SCORE_CN,
    game.GAME_INN_NO, game.GAME_TB_SC].join("|");
}

export function recordLiveScoreAgreement(
  game: KboRawGame,
  scheduleAway: number | null,
  scheduleHome: number | null,
  observedAtMs: number,
): void {
  if (game.GAME_STATE_SC !== "2" || scheduleAway === null || scheduleHome === null ||
      !Number.isInteger(scheduleAway) || !Number.isInteger(scheduleHome) || scheduleAway < 0 || scheduleHome < 0 ||
      String(scheduleAway) !== game.T_SCORE_CN || String(scheduleHome) !== game.B_SCORE_CN) return;
  proofs.set(game, { snapshot: snapshot(game), observedAtMs });
}

export function hasLiveScoreAgreement(game: KboRawGame, nowMs = Date.now()): boolean {
  const proof = proofs.get(game);
  if (!proof) return false;
  const age = nowMs - proof.observedAtMs;
  return age >= 0 && age <= SCORE_EVIDENCE_MAX_AGE_MS && proof.snapshot === snapshot(game);
}
