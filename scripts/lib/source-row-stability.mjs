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
 * 원본을 N회(N>=2) 관측해 행 키를 세 갈래로 가른다.
 *
 *   - 전 회차 관측  → stable   : 행 집합 대조 대상. 없거나 남으면 **그대로 실패**다.
 *   - 일부 회차만   → unstable : 원본이 흔든 것. 행 집합 실패로 **세지 않는다**.
 *   - 0회          → 부재      : 애초에 union 에 없다.
 *
 * ⚠︎ 이건 완화가 아니다. 세 가지를 지킨다.
 *   1) **값 대조는 손대지 않는다.** unstable 행이라도 관측된 회차의 필드값은
 *      그대로 엄격 비교한다. 흔들리는 건 "행의 존재"지 "값"이 아니다.
 *   2) 관측이 0회거나 0행이면 **안정이 아니라 실패**다. 수집 실패를 "다 안정"으로
 *      읽으면 그게 곧 false-green 이고, 이 파일 전체가 게이트를 지운 것과 같아진다.
 *   3) 관측 1회로는 unstable 을 만들 수 없다. 1회 관측은 정의상 전부 stable 이라
 *      종전과 정확히 같은 strict 판정이 된다 — 그래서 "2회 미만 금지"를 별도로 강제한다
 *      (`assertConfirmReads`). 이게 없으면 호출부에서 reads=1 한 줄로 계약이 사라지는데
 *      union·stable 은 여전히 그럴듯하게 채워져 아무도 못 잡는다.
 */

/** 확인 재조회 최소 횟수. 이보다 적으면 불안정을 **판정할 수 없다**(있다/없다 구분 불가). */
export const MIN_CONFIRM_READS = 2;

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
 * 관측 N회를 접어 행 키를 stable/unstable 로 가른다.
 *
 * @param {Array<Map<string, string[]>>} observations 회차별 `key → 원본 셀 텍스트`
 * @returns {{ union: Map<string, string[]>, stableKeys: Set<string>, unstableKeys: Set<string>, reads: number }}
 */
export function classifyRowStability(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error(
      "row_stability_no_observations: 관측 0회 — 판정 불가(검증 불가를 통과로 취급하지 않는다)",
    );
  }

  const union = new Map();
  const seenCount = new Map();

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
      if (!union.has(key)) union.set(key, value);
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

  return { union, stableKeys, unstableKeys, reads };
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
