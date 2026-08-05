const DEFAULT_MAX_DELTA = 10;

function playerKey(row) {
  const id = String(row?.kboId || row?.playerId || "").trim();
  return id || `${String(row?.name || "").trim()}|${String(row?.team || "").trim()}`;
}

/** 수비는 한 선수가 여러 포지션을 보므로 `(kboId, pos)` 복합키가 행 식별자다. */
function defenseKey(row) {
  return `${playerKey(row)}|${String(row?.pos || "").trim()}`;
}

/**
 * 이전 스냅샷 대비 급락/대량 누락을 차단하는 공통 가드.
 *
 * ⚠︎ 종전에는 이 가드가 *투수에만* 걸려 있었다. 그래서 타자·수비·수비runs는
 * 페이지네이션이 끊겨 데이터가 무너져도 그대로 파일에 썼다.
 * 실측 사고(2026-08-04): 수비 823행 → 30행(첫 페이지 한 장만 남음)으로 유실됐는데
 * 아무 게이트도 발동하지 않고 정상 종료했다.
 */
export function validateSnapshot(label, previous, candidate, {
  maxDelta = DEFAULT_MAX_DELTA,
  keyOf = playerKey,
} = {}) {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new Error(`${label}_snapshot_empty`);
  }
  if (!Array.isArray(previous) || previous.length === 0) return;

  const countDelta = Math.abs(candidate.length - previous.length);
  const candidateKeys = new Set(candidate.map(keyOf));
  const missing = previous.filter((row) => !candidateKeys.has(keyOf(row)));
  if (countDelta > maxDelta || missing.length > maxDelta) {
    const sample = missing.slice(0, 5).map(keyOf).join(",");
    throw new Error(
      `${label}_snapshot_partial:previous=${previous.length},candidate=${candidate.length},`
      + `countDelta=${countDelta},missing=${missing.length},sample=${sample}`,
    );
  }
}

export function validatePitcherSnapshot(previous, candidate, maxDelta = DEFAULT_MAX_DELTA) {
  validateSnapshot("pitcher", previous, candidate, { maxDelta });
}

export function validateBatterSnapshot(previous, candidate, maxDelta = DEFAULT_MAX_DELTA) {
  validateSnapshot("batter", previous, candidate, { maxDelta });
}

export function validateDefenseSnapshot(previous, candidate, maxDelta = DEFAULT_MAX_DELTA) {
  validateSnapshot("defense", previous, candidate, { maxDelta, keyOf: defenseKey });
}

/**
 * 수비 runs는 배열이 아니라 `{ kboId: runs }` 맵이다.
 * 키 급락을 같은 기준으로 막는다(823행 유실 시 271 → 30으로 동반 붕괴했다).
 */
export function validateDefenseRunsSnapshot(previous, candidate, maxDelta = DEFAULT_MAX_DELTA) {
  const toRows = (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).map((kboId) => ({ kboId }))
      : [];
  validateSnapshot("defense_runs", toRows(previous), toRows(candidate), { maxDelta });
}
