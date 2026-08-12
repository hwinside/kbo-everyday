/**
 * 로스터 신원 변경의 **census 영향 판정** — 완전 무인화 축 (2026-08-12, 하린아빠 지시).
 *
 * ── 왜 이게 가능한가 ────────────────────────────────────────────────────────
 * census 판정(`corpus-identity-census.ts`)이 로스터에서 소비하는 값은 정확히 두 가지다:
 *   1. entity 이름의 **동명이인 후보 수** (`byName.get(entity).length`)
 *   2. 후보가 1명일 때 그 선수의 **birthDate**
 * 그리고 census 에는 corpus 선수 루트문서의 entity 이름 전건(631명)이 이미 커밋돼 있다.
 * 따라서 corpus 원본(175MB, T7 전용) 없이도 CI 에서 다음이 결정론적으로 판정된다:
 *
 *   **변경된 신원 튜플의 이름이 census entity 집합과 교집합이 없으면, 어떤 census 행의
 *   판정 입력도 변하지 않는다** — 신규/이탈 선수의 corpus 루트문서 자체가 없기 때문이다.
 *
 * 케이스 확인:
 *   - 신규 선수 추가(이름이 census entity 아님): 어떤 행의 후보 수·생년도 안 변함 → 비영향.
 *   - 신규 선수 추가(이름이 census entity): 그 entity 후보 수 1→2 → 판정이
 *     `roster_name_ambiguous` 로 바뀌어야 함 → **영향**.
 *   - census entity 선수의 birthDate/kboId/이름 변경·이탈: 해당 행 입력 변화 → **영향**.
 *     (kboId 는 verdict 입력은 아니지만 census 행에 기록되는 값이라 fail-close 로 묶는다.)
 *
 * ── fail-close 계약 ────────────────────────────────────────────────────────
 * 판정 불가(파싱 실패·빈 입력·결속 붕괴)는 전부 "영향 있음" 쪽으로 떨어진다.
 */

export type IdentityImpactVerdict =
  | { affected: false; changedNames: string[] }
  | { affected: true; reason: "affected_census_entities" | "unparseable"; affectedNames: string[] };

/** canonical 튜플 문자열(JSON 배열)에서 이름을 꺼낸다. 실패는 null — 호출부가 fail-close 한다. */
export function tupleName(tuple: string): string | null {
  try {
    const parsed = JSON.parse(tuple);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    return parsed[0] === null || parsed[0] === undefined ? null : String(parsed[0]);
  } catch {
    return null;
  }
}

/** 두 정렬 튜플 목록의 multiset 대칭차 — 변경(추가·삭제·필드수정)된 튜플 전부. */
export function multisetSymmetricDiff(base: readonly string[], current: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const tuple of base) counts.set(tuple, (counts.get(tuple) ?? 0) + 1);
  for (const tuple of current) counts.set(tuple, (counts.get(tuple) ?? 0) - 1);
  const diff: string[] = [];
  for (const [tuple, count] of counts) {
    for (let index = 0; index < Math.abs(count); index += 1) diff.push(tuple);
  }
  return diff;
}

/**
 * 신원 drift 의 census 영향 판정.
 * @param baseTuples census 에 저장된 기준 신원 multiset(정렬 canonical 튜플)
 * @param currentTuples 현재 로스터의 신원 multiset
 * @param censusEntities census rows 의 entity 이름 전건
 */
export function classifyIdentityDrift(
  baseTuples: readonly string[],
  currentTuples: readonly string[],
  censusEntities: ReadonlySet<string>,
): IdentityImpactVerdict {
  if (baseTuples.length === 0 || currentTuples.length === 0 || censusEntities.size === 0) {
    return { affected: true, reason: "unparseable", affectedNames: [] };
  }
  const changed = multisetSymmetricDiff(baseTuples, currentTuples);
  const changedNames = new Set<string>();
  for (const tuple of changed) {
    const name = tupleName(tuple);
    // 이름을 못 읽는 튜플은 어느 행에 닿는지 알 수 없다 — fail-close.
    if (name === null) return { affected: true, reason: "unparseable", affectedNames: [] };
    changedNames.add(name);
  }
  const affectedNames = [...changedNames].filter((name) => censusEntities.has(name));
  if (affectedNames.length > 0) {
    return { affected: true, reason: "affected_census_entities", affectedNames };
  }
  return { affected: false, changedNames: [...changedNames] };
}
