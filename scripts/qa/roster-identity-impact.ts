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

import { createHash } from "node:crypto";

export type IdentityImpactVerdict =
  | { affected: false; changedNames: string[] }
  | { affected: true; reason: "affected_census_entities" | "unparseable"; affectedNames: string[] };

/**
 * 영향 판정이 쓸 **영속 universe** 를 census 산출물에서 꺼낸다 (삼순 시간축 NO-GO 2026-08-12).
 *
 * ⚠️ 왜 rows 가 아닌가: rows 는 corpus root ∩ 현재 로스터다. corpus 대상 선수가 이탈하면
 *   다음 T7 재생성에서 그 이름이 rows 에서 사라지고, 이후 같은 이름의 새 선수가 등록되면
 *   ∩ rows = ∅ 로 false-GREEN 이 된다 — T7 엔 과거 root 문서가 여전히 있는데도.
 *   그래서 universe 는 roster 필터 **전** 전체 player root(`corpusRootEntities`)를 쓴다.
 *
 * fail-close: 필드 부재·빈 목록·해시 불일치(원문 변조)는 예외를 던져 게이트를 깨늈다.
 */
export function impactUniverseFromCensus(census: {
  corpusRootEntities?: unknown;
  corpusRootEntitiesSha256?: unknown;
}): Set<string> {
  const entities = census.corpusRootEntities;
  if (!Array.isArray(entities) || entities.length === 0 || entities.some((name) => typeof name !== "string")) {
    throw new Error("census 에 영속 universe(corpusRootEntities)가 없다 — T7 에서 census 를 재생성해야 한다");
  }
  const computed = createHash("sha256").update((entities as string[]).join("\n")).digest("hex");
  if (computed !== census.corpusRootEntitiesSha256) {
    throw new Error("corpusRootEntities 가 저장된 해시와 결속되지 않는다 — universe 원문이 변조됐다");
  }
  return new Set(entities as string[]);
}

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
 * **drift 게이트 단일 경로** — 지문 비교부터 영향 분류까지 한 함수다.
 *
 * ⚠️ 왜 함수로 묶는가 (mutation I-1 GREEN 실측, 2026-08-12): 이 로직이 smoke 인라인이면
 *   "universe 를 rows 로 회귀" 변이를 잡을 수 없다 — 지문이 일치하는 평소엔 drift 경로가
 *   실행되지 않아 어떤 assert 도 안 깨진다. 함수로 뽑으면 smoke 계약 섹션이 **합성
 *   시간축 census**(universe ⊋ rows)로 같은 함수를 직접 태워 회귀를 검출한다.
 */
export function judgeRosterDriftAgainstCensus(
  census: {
    rosterIdentityTuples?: unknown;
    rosterIdentitySha256?: unknown;
    corpusRootEntities?: unknown;
    corpusRootEntitiesSha256?: unknown;
  },
  currentTuples: readonly string[],
  fingerprintOfTuples: (tuples: readonly string[]) => string,
):
  | { status: "fingerprint_match" }
  | { status: "accepted"; changedNames: string[] }
  | { status: "regenerate"; reason: string; affectedNames: string[] } {
  const stored = census.rosterIdentityTuples;
  if (!Array.isArray(stored) || stored.length === 0 || stored.some((tuple) => typeof tuple !== "string")) {
    return { status: "regenerate", reason: "base_tuples_missing", affectedNames: [] };
  }
  if (fingerprintOfTuples(stored as string[]) !== census.rosterIdentitySha256) {
    return { status: "regenerate", reason: "base_tuples_tampered", affectedNames: [] };
  }
  if (fingerprintOfTuples(currentTuples) === census.rosterIdentitySha256) {
    return { status: "fingerprint_match" };
  }
  // ⚠️ universe 는 rows(∩ 현재 로스터)가 아니라 영속 universe 다 — rows 로 회귀하면
  //   corpus 이름 선수 이탈 → T7 재생성 → 동일 이름 재등록이 false-GREEN 이 된다.
  const verdict = classifyIdentityDrift(stored as string[], currentTuples, impactUniverseFromCensus(census));
  if (verdict.affected) {
    return { status: "regenerate", reason: verdict.reason, affectedNames: verdict.affectedNames };
  }
  return { status: "accepted", changedNames: verdict.changedNames };
}

/**
 * 신원 drift 의 census 영향 판정.
 * @param baseTuples census 에 저장된 기준 신원 multiset(정렬 canonical 튜플)
 * @param currentTuples 현재 로스터의 신원 multiset
 * @param censusEntities 영속 universe(roster 필터 전 전체 corpus root entity)
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
