/**
 * KBO 원본의 **행 존재 불안정(row instability)** 판정 — 순수 로직.
 *
 * ── 배경(2026-08-08, 실측) ──────────────────────────────────────
 * 자동 스탯 갱신이 8/6·8/7 연속으로 죽었다. 실패 문구는 늘 같았다.
 *
 *   수비: KBO에 있으나 우리 데이터에 없음 — playerId=54214|중견수 (전다민)
 *   ❌ stats_freshness_mismatch: 221s 구간에서 동일하게 1건 불일치
 *
 * 게이트는 "원본이 흔들린 게 아니라 스냅샷이 실제로 다르다"고 판정했지만, 이건 틀렸다.
 * origin/main 의 `collectKboDefensePages` 로 같은 URL 을 5회 독립 조회한 실측:
 *
 *   읽기1 824행 · 전다민 = 좌익수만        읽기4 824행 · 전다민 = 중견수만
 *   읽기2 824행 · 전다민 = 중견수만        읽기5 825행 · 전다민 = 좌익수 + 중견수
 *   읽기3 824행 · 전다민 = 좌익수만
 *
 * 중복행·페이저 유실이 아니다(distinctKeys == rawRows, dupRows 0, tail 동일).
 * KBO 가 rank 동률 최하위 구간의 행을 **조회마다 줬다 안 줬다** 한다.
 *
 * 그래서 실패가 재현된 것이지, 스냅샷이 오염된 게 아니다. 메커니즘:
 *   ① 크롤이 한 번 읽어 산출물을 굳힌다 → 그 회차가 824면 한 행이 빠진 채 확정
 *   ② 오라클이 *다시* 읽는다 → 825 가 나오면 "KBO엔 있는데 우리엔 없다"
 *   ③ 산출물은 이미 고정이라 재판독해도 결과가 안 바뀐다 → "안정된 FAIL" 로 확정
 * 즉 게이트가 **한 번의 운 나쁜 읽기를 영구 동결**하고 있었다.
 *
 * ── 계약 ────────────────────────────────────────────────────────
 * 원본을 N회(N>=3) 관측해 행 키를 세 갈래로 가른다.
 *
 *   - 전 회차 관측  → stable   : 행 집합 대조 대상. 없거나 남으면 **그대로 실패**다.
 *   - 일부 회차만   → unstable : 원본이 흔든 것. 행 집합 실패로 **세지 않는다**.
 *   - 0회          → 부재      : 애초에 union 에 없다.
 *
 * ⚠︎ 이건 완화가 아니다. 네 가지를 지킨다.
 *   1) **값 대조는 손대지 않는다.** unstable 행이라도 관측된 회차의 필드값은
 *      그대로 엄격 비교한다. 흔들리는 건 "행의 존재"지 "값"이 아니다.
 *   2) 같은 key 가 회차마다 **다른 값**을 주면 그건 불안정이 아니라 오염 후보다.
 *      first-write 든 last-write 든 하나를 남기면 충돌이 조용히 사라진다(삼순 지적).
 *      `valueConflictKeys` 로 뽑아 호출자가 fail-close 하게 한다.
 *   3) 관측이 0회거나 0행이면 **안정이 아니라 실패**다. 수집 실패를 "다 안정"으로
 *      읽으면 그게 곧 false-green 이다.
 *   4) 관측 1~2회로는 "매번 나온다"를 말할 수 없다. 하한을 코드로 강제한다
 *      (`assertConfirmReads`). 하한이 없으면 호출부 한 줄로 계약이 사라지는데
 *      union·stable 은 여전히 그럴듯하게 채워져 아무도 못 잡는다.
 *
 * ⚠︎ 2026-08-08 삼순 NO-GO 반영: 하한이 2였을 때 실제로 뚫렸다.
 * `좌,좌` 두 번을 뽑으면 중견수 행이 union 에서 빠져 **기존 행이 삭제**되고,
 * 오라클도 `좌` 를 보면 row-set 불일치가 없어 재조회 트리거조차 안 걸린다
 * — 양쪽 다 GREEN 인 채로 행이 사라진다. 하한을 3으로 올리고, 크롤 쪽은
 * baseline 결속(`decideRowRetention`)까지 함께 둔다.
 */

/** 확인 재조회 최소 횟수. 2회로는 `좌,좌` 우연이 그대로 통과한다(실측). */
export const MIN_CONFIRM_READS = 3;

/**
 * baseline 에 있던 key 가 이번 런에서 0회 관측일 때, 몇 런 연속이어야 삭제하는가.
 *
 * ⚠︎ 한 런 `0/N` 만으로 지우면 안 된다 — 알려진 불안정 행이 운 나쁘게 N번 모두
 * 빠질 수 있고, 그러면 이 PR 이 고치려던 "조용한 행 삭제"가 그대로 재발한다(삼순 지적).
 */
export const MISS_RUNS_BEFORE_DELETE = 2;

/**
 * 확인 재조회 횟수 계약. 하한 미만이면 던진다.
 *
 * ⚠︎ "부족하면 조용히 strict 로 되돌린다"로 두면 안 된다. 그건 호출부 한 줄로
 * 이 모듈을 무력화하면서도 전 게이트가 GREEN 인 상태를 만든다.
 */
export function assertConfirmReads(reads) {
  if (!Number.isInteger(reads) || reads < MIN_CONFIRM_READS) {
    throw new Error(
      `row_stability_insufficient_reads: 확인 재조회 ${reads}회 — `
        + `최소 ${MIN_CONFIRM_READS}회여야 행 불안정을 판정할 수 있다(fail-close)`,
    );
  }
  return reads;
}

/**
 * 관측 N회를 접어 행 키를 stable/unstable 로 가르고, 값 충돌 key 를 함께 뽑는다.
 *
 * @param {Array<Map<string, string[]>>} observations 회차별 `key → 원본 셀 텍스트`
 * @returns {{
 *   union: Map<string, string[]>,
 *   stableKeys: Set<string>,
 *   unstableKeys: Set<string>,
 *   valueConflictKeys: Set<string>,
 *   seenCount: Map<string, number>,
 *   reads: number,
 * }}
 */
export function classifyRowStability(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error(
      "row_stability_no_observations: 관측 0회 — 판정 불가(검증 불가를 통과로 취급하지 않는다)",
    );
  }

  const union = new Map();
  const seenCount = new Map();
  const valueConflictKeys = new Set();

  for (const [index, observation] of observations.entries()) {
    if (!(observation instanceof Map)) {
      throw new Error(`row_stability_bad_observation: ${index}회차가 Map 이 아니다`);
    }
    // 0행 관측은 "그 행들이 전부 불안정"이 아니라 **수집 실패**다.
    // 이걸 허용하면 네트워크가 죽은 회차 하나로 전 행이 unstable 이 되어 대조가 사라진다.
    if (observation.size === 0) {
      throw new Error(
        `row_stability_empty_observation: ${index}회차 0행 — 수집 실패를 불안정으로 오판할 수 없다`,
      );
    }
    for (const [key, value] of observation) {
      if (!union.has(key)) {
        union.set(key, value);
      } else if (!sameCells(union.get(key), value)) {
        // 같은 key 인데 회차마다 값이 다르다. 어느 쪽을 남겨도 충돌이 사라진다.
        valueConflictKeys.add(key);
      }
      seenCount.set(key, (seenCount.get(key) ?? 0) + 1);
    }
  }

  const reads = observations.length;
  const stableKeys = new Set();
  const unstableKeys = new Set();
  for (const [key, count] of seenCount) {
    if (count === reads) stableKeys.add(key);
    else unstableKeys.add(key);
  }

  return { union, stableKeys, unstableKeys, valueConflictKeys, seenCount, reads };
}

/** 셀 배열 동일성. 원본은 문자열 배열이므로 요소별 비교로 충분하다. */
function sameCells(a, b) {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (String(left[i]) !== String(right[i])) return false;
  }
  return true;
}

/**
 * 값 충돌을 실패 문장으로. 호출자는 이걸 **그대로 죽는 근거**로 쓴다.
 */
export function describeValueConflicts(label, valueConflictKeys, { limit = 10 } = {}) {
  const keys = [...valueConflictKeys];
  if (keys.length === 0) return null;
  const shown = keys.slice(0, limit).join(", ");
  const suffix = keys.length > limit ? ` 외 ${keys.length - limit}건` : "";
  return `${label}: 원본이 같은 key 에 회차별로 다른 값을 줬다 ${keys.length}건 — ${shown}${suffix}`
    + " (어느 회차를 남겨도 충돌이 사라지므로 fail-close)";
}

/**
 * 불안정 행 목록을 사람이 읽을 한 줄로.
 * 알림·요약에서 "왜 통과시켰는지"를 남기기 위한 것이다 — 조용히 넘기지 않는다.
 */
export function describeUnstableRows(label, unstableKeys, union, { limit = 10 } = {}) {
  const keys = [...unstableKeys];
  if (keys.length === 0) return null;
  const shown = keys.slice(0, limit).map((key) => {
    const name = union.get(key)?.[1] ?? "?";
    return `${key}(${name})`;
  });
  const suffix = keys.length > limit ? ` 외 ${keys.length - limit}건` : "";
  return `${label}: 원본 행 불안정 ${keys.length}건 — ${shown.join(", ")}${suffix}`;
}

/**
 * 크롤 쓰기 경로의 **행 유지 판정** — baseline 과 이번 관측을 함께 본다.
 *
 * ⚠︎ 관측만으로 산출물을 만들면(= baseline 미참조) `좌,좌,좌` 를 뽑은 런이 중견수 행을
 * 조용히 지운다. 개수 델타 가드(Δ≤10)도 1행 삭제는 못 잡고, 오라클도 같은 회차를 보면
 * 불일치가 없어 재조회조차 안 한다 — 양쪽 GREEN 인 채로 행이 사라진다(삼순 실증).
 *
 * 판정:
 *   - 이번에 1회 이상 관측  → 유지(관측값 사용). 신규든 기존이든 같다.
 *   - baseline 에 있고 0회  → **바로 지우지 않는다**. miss streak 를 올리고,
 *     `MISS_RUNS_BEFORE_DELETE` 연속 런에서 0회일 때만 제거한다.
 *   - baseline 에 없고 0회  → 애초에 없는 행이다.
 *
 * @param {object} input
 * @param {Map<string, any>} input.baselineByKey 직전 산출물 `key → row`
 * @param {Map<string, any>} input.observedByKey 이번 런 union `key → row`
 * @param {Map<string, number>} input.seenCount 이번 런 key 별 관측 횟수
 * @param {Record<string, number>} input.previousMissStreak 이전 런까지의 연속 미관측 횟수
 * @returns {{ keptKeys: string[], deletedKeys: string[], heldKeys: string[], missStreak: Record<string, number> }}
 */
export function decideRowRetention({
  baselineByKey,
  observedByKey,
  seenCount,
  previousMissStreak = {},
}) {
  const keptKeys = [];
  const deletedKeys = [];
  const heldKeys = [];
  const missStreak = {};

  for (const key of observedByKey.keys()) {
    keptKeys.push(key);
  }

  for (const key of baselineByKey.keys()) {
    if ((seenCount.get(key) ?? 0) > 0) continue; // 이번에 봤으면 이미 kept
    const streak = (previousMissStreak[key] ?? 0) + 1;
    if (streak >= MISS_RUNS_BEFORE_DELETE) {
      deletedKeys.push(key);
    } else {
      heldKeys.push(key);
      missStreak[key] = streak;
    }
  }

  return { keptKeys, deletedKeys, heldKeys, missStreak };
}
