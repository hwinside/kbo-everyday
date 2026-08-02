const DEFAULT_MAX_DELTA = 10;

function playerKey(row) {
  const id = String(row?.kboId || row?.playerId || "").trim();
  return id || `${String(row?.name || "").trim()}|${String(row?.team || "").trim()}`;
}
export function validatePitcherSnapshot(previous, candidate, maxDelta = DEFAULT_MAX_DELTA) {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new Error("pitcher_snapshot_empty");
  }
  if (!Array.isArray(previous) || previous.length === 0) return;

  const countDelta = Math.abs(candidate.length - previous.length);
  const candidateKeys = new Set(candidate.map(playerKey));
  const missing = previous.filter((row) => !candidateKeys.has(playerKey(row)));
  if (countDelta > maxDelta || missing.length > maxDelta) {
    const sample = missing.slice(0, 5).map(playerKey).join(",");
    throw new Error(
      `pitcher_snapshot_partial:previous=${previous.length},candidate=${candidate.length},`
      + `countDelta=${countDelta},missing=${missing.length},sample=${sample}`,
    );
  }
}
