import assert from "node:assert/strict";

/** 운영 full-shape에서 원천 대조 승인표가 실제로 치유해야 하는 stale key 집합. */
export const EXPECTED_STALE_DELETIONS: Readonly<Record<string, readonly string[]>> = {
  "20260430SSOB0": ["65040|pitcher"],
  "20260505WOSS0": ["50167|batter", "65040|pitcher"],
  "20260512SSLG0": ["51301|batter", "65040|pitcher"],
  "20260517HTSS0": ["65040|pitcher"],
};

export function assertDeletionKeysMatchStaleKeys(
  gameId: string,
  deletionKeys: readonly string[],
  staleKeys: readonly string[],
): void {
  assert.deepEqual(
    [...deletionKeys].sort(),
    [...staleKeys].sort(),
    `${gameId}: 삭제 key 집합이 stale key 집합과 정확히 일치하지 않음`,
  );
}

export function assertExpectedApprovedHeals(
  actual: Readonly<Record<string, readonly string[]>>,
): void {
  assert.deepEqual(
    Object.fromEntries(Object.entries(actual).map(([gameId, keys]) => [gameId, [...keys].sort()])),
    Object.fromEntries(Object.entries(EXPECTED_STALE_DELETIONS).map(([gameId, keys]) => [gameId, [...keys].sort()])),
    "승인된 stale 치유 4경기의 exact 삭제 집합이 운영 기준과 다름",
  );
}
