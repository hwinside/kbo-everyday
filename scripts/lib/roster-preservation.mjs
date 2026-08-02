/**
 * 기록 페이지에 없는 기존 선수(군 복무·미출장 포함)를 roster SSOT에 보존한다.
 * 같은 canonical id가 이번 수집에 있으면 최신 수집값이 우선하며 기존값으로 덮지 않는다.
 */
export function preserveExistingRosterPlayers(allPlayers, existingPlayers, canonicalKboId) {
  let preserved = 0;
  for (const [kboId, existing] of existingPlayers) {
    const canonicalId = canonicalKboId(kboId);
    if (allPlayers.has(canonicalId)) continue;
    allPlayers.set(canonicalId, { ...existing, kboId: canonicalId });
    preserved++;
  }
  return preserved;
}
