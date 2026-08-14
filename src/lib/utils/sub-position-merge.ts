import type { BatterRecord } from "@/app/api/game-detail/route";
import { normalizeFieldPosition, PURE_SUB_POSITIONS } from "@/lib/utils/game-derived";

/**
 * KBO BoxScore가 대타/대주 교체 선수의 수비 위치를 끝까지 '대/주'로 방치하는
 * 경우가 있다(실측: 20260812LGWO0 김웅빈 '대'·박채울 '주' — 9회초 수비 내내
 * 미갱신 → 필드뷰 1B/CF 빈 자리). 반면 Naver record는 같은 선수를 '타一'·'주중'
 * 같은 복합 위치로 정확히 내려준다.
 *
 * 이 함수는 KBO BoxScore의 *순수 대/주/타* entry에 한해, Naver BoxScore에서
 * 같은 (order, name) 선수의 위치가 실제 수비 위치로 해석 가능하면 그 위치로
 * 교체한다(소스 진실 우선 — 추정 아님). 그 외 entry는 건드리지 않는다.
 *
 * 더블스위치(미확정 2명이 서로 위치를 바꾸는 경우)도 Naver가 선수별 위치를
 * 주므로 여기서 올바르게 풀린다. Naver도 없거나 순수 대/주면 그대로 둔다
 * (클라 toDefenders의 단일 미확정 상속 또는 fail-empty로 이어짐).
 */
export function hasPureSubPositions(batters: {
  awayBatters: BatterRecord[];
  homeBatters: BatterRecord[];
}): boolean {
  const isPure = (b: BatterRecord) => PURE_SUB_POSITIONS.has((b.position ?? "").trim());
  return batters.awayBatters.some(isPure) || batters.homeBatters.some(isPure);
}

function mergeSide(target: BatterRecord[], source: BatterRecord[]): void {
  for (const t of target) {
    const raw = (t.position ?? "").trim();
    if (!PURE_SUB_POSITIONS.has(raw)) continue;
    const s = source.find(x => x.order === t.order && x.name === t.name);
    if (!s) continue;
    const resolved = normalizeFieldPosition(s.position);
    if (!resolved) continue; // Naver도 순수 대/주 → 보정 불가, fail-safe 유지
    t.position = s.position;
    if (s.positionFull) t.positionFull = s.positionFull;
  }
}

export function mergeNaverSubPositions(
  target: { awayBatters: BatterRecord[]; homeBatters: BatterRecord[] },
  source: { awayBatters: BatterRecord[]; homeBatters: BatterRecord[] },
): void {
  mergeSide(target.awayBatters, source.awayBatters);
  mergeSide(target.homeBatters, source.homeBatters);
}
