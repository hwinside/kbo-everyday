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
 * 메커니즘: 크롤이 한 번 읽어 산출물을 굳히면, 오라클이 다른 회차를 읽었을 때
 * "실제로 다르다"가 안정적으로 재현된다. 산출물이 이미 고정이라 재판독으로는 안 풀린다.
 *
 * ── 원장(ledger)이 필요한 이유 ─────────────────────────────────
 * 크롤이 N회 읽어 불안정을 알아내도, **오라클은 그 사실을 모른다**. 오라클이 우연히
 * N회 모두 그 행을 놓치면 다시 "우리에만 있음"으로 죽는다(삼순 실증). 그래서 크롤이
 * 관측한 불안정 사실을 **산출물과 같은 promote 에 실어** 오라클이 구조적으로 읽게 한다.
 * caller 주입이 아니라 payload 파생이므로 한 줄로 끌 수 없다.
 *
 * ⚠︎ 원장은 "행 존재" 판정만 면제한다. 값 대조는 그대로 엄격하고, 원장이 커지면
 * (원본이 광범위하게 흔들리는 상황) 면제가 아니라 fail-close 다(`assertLedgerBounded`).
 */

/** 확인 재조회 최소 횟수. 2회로는 `좌,좌` 우연이 그대로 통과한다(실측). */
export const MIN_CONFIRM_READS = 3;

/**
 * baseline 에 있던 key 가 이번 런에서 0회 관측일 때, 몇 런 연속이어야 삭제하는가.
 *
 * ⚠︎ 한 런 `0/N` 만으로 지우면 안 된다 — 알려진 불안정 행이 운 나쁘게 N번 모두
 * 빠질 수 있고, 그러면 이 PR 이 고치려던 "조용한 행 삭제"가 그대로 재발한다.
 */
export const MISS_RUNS_BEFORE_DELETE = 2;

/** 원장 상한 — 비율과 절대 하한 중 큰 쪽. 넘으면 면제가 아니라 실패다. */
export const LEDGER_MAX_RATIO = 0.02;
export const LEDGER_MIN_ALLOWANCE = 10;

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

/** 값 충돌을 실패 문장으로. 호출자는 이걸 **그대로 죽는 근거**로 쓴다. */
export function describeValueConflicts(label, valueConflictKeys, { limit = 10 } = {}) {
  const keys = [...valueConflictKeys];
  if (keys.length === 0) return null;
  const shown = keys.slice(0, limit).join(", ");
  const suffix = keys.length > limit ? ` 외 ${keys.length - limit}건` : "";
  return `${label}: 원본이 같은 key 에 회차별로 다른 값을 줬다 ${keys.length}건 — ${shown}${suffix}`
    + " (어느 회차를 남겨도 충돌이 사라지므로 fail-close)";
}

/** 불안정 행 목록을 사람이 읽을 한 줄로. 조용히 넘기지 않는다. */
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
 * 크롤 쓰기 경로의 **스냅샷 구성 계획** — baseline·이번 관측·직전 원장을 함께 본다.
 *
 * 규칙(삼순 pin):
 *   - `N/N` stable            → 포함(관측값)
 *   - `1..N-1`, baseline 있음 → 포함(관측값). 기존 canonical 행이므로 흔들린다고 지우지 않는다
 *   - `1..N-1`, baseline 없음 → **격리(quarantine)**. 신규 행은 한 번 스쳐 봤다고 canonical 로
 *                                올리지 않는다. 직전 원장에도 있었다면(= 지난 런에도 보였다) 승격
 *   - `0/N`,   baseline 있음  → 보존(hold). 연속 `MISS_RUNS_BEFORE_DELETE` 런째면 제거
 *
 * 원장에는 "완전 안정이 아닌" 키만 남는다. 오라클은 이걸 읽어 **행 존재** 판정에서만 면제한다.
 *
 * @returns {{
 *   includeKeys: string[], quarantinedKeys: string[], heldKeys: string[], deletedKeys: string[],
 *   ledger: { reads: number, rows: Record<string, {observed:number, missStreak:number}> },
 * }}
 */
export function planRowSnapshot({
  baselineByKey,
  classified,
  previousLedger = { rows: {} },
  label = "행",
}) {
  const previousRows = previousLedger?.rows ?? {};
  const includeKeys = [];
  const quarantinedKeys = [];
  const heldKeys = [];
  const deletedKeys = [];
  const rows = {};

  for (const [key, observed] of classified.seenCount) {
    if (observed === classified.reads) {
      includeKeys.push(key);
      continue;
    }
    // 여기부터 intermittent(1..N-1)
    const inBaseline = baselineByKey.has(key);
    const seenLastRun = Object.prototype.hasOwnProperty.call(previousRows, key);
    if (inBaseline || seenLastRun) {
      includeKeys.push(key);
    } else {
      // 신규 intermittent — canonical 직행 금지. 원장에만 남겨 다음 런에 승격 판단한다.
      quarantinedKeys.push(key);
    }
    rows[key] = { observed, missStreak: 0 };
  }

  for (const key of baselineByKey.keys()) {
    if ((classified.seenCount.get(key) ?? 0) > 0) continue;
    const streak = (previousRows[key]?.missStreak ?? 0) + 1;
    if (streak >= MISS_RUNS_BEFORE_DELETE) {
      deletedKeys.push(key);
    } else {
      heldKeys.push(key);
      rows[key] = { observed: 0, missStreak: streak };
    }
  }

  return {
    includeKeys,
    quarantinedKeys,
    heldKeys,
    deletedKeys,
    ledger: { label, reads: classified.reads, rows },
  };
}

/** 원장에 등재된 키 집합. 오라클이 행 존재 판정에서 면제할 대상이다. */
export function ledgerKeySet(ledger) {
  return new Set(Object.keys(ledger?.rows ?? {}));
}

/**
 * 원장 상한 — 몇 행이 흔드는 건 원본 특성이지만, 광범위하게 흔들리면 그건 다른 사고다.
 *
 * ⚠︎ 상한이 없으면 원장이 곧 무제한 면제 목록이 된다. 원장을 통째로 채우면 행 집합
 * 대조가 사실상 사라지는데, 그 상태에서도 전 게이트가 GREEN 이다.
 */
export function assertLedgerBounded(ledger, totalRows, { label = "행" } = {}) {
  const size = Object.keys(ledger?.rows ?? {}).length;
  const allowed = Math.max(LEDGER_MIN_ALLOWANCE, Math.floor(totalRows * LEDGER_MAX_RATIO));
  if (size > allowed) {
    throw new Error(
      `row_stability_ledger_overflow: ${label} 불안정 행 ${size}건 > 허용 ${allowed}건`
        + ` (전체 ${totalRows}행) — 원본이 광범위하게 흔들린다. 면제가 아니라 수집을 다시 해야 한다`,
    );
  }
  return size;
}
