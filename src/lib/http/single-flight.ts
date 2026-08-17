/**
 * In-flight single-flight coalescer (staleness 0).
 *
 * 같은 key로 *이미 진행 중인* factory 실행이 있으면 그 Promise를 공유하고, 없으면 새로
 * 시작해 등록한다. Promise가 settle(성공/실패)되면 즉시 등록을 해제한다.
 *
 * ── 신선도 계약 ──────────────────────────────────────────────────────────
 * TTL 저장이 없다. 오직 "시간적으로 겹친" 동시 호출만 한 번의 실행으로 접는다.
 * settle 이후의 호출은 *항상* 새 factory를 실행하므로 모든 호출자가 갓 계산된 결과를
 * 받는다 = 활성 유저 신선도 저하 0. (릴레이식 TTL 캐시와 달리 낡은 스냅샷을 재사용하지
 * 않는다.)
 *
 * ── 에러 계약 ────────────────────────────────────────────────────────────
 * 진행 중 factory가 reject하면 그 시점의 모든 대기자가 같은 에러를 받는다. 성공/실패
 * 무관하게 settle 즉시 등록 해제하므로 실패가 다음 호출까지 고정되지 않는다(자가복구).
 *
 * factory의 동기 throw도 rejection으로 정규화한다(Promise.resolve().then).
 */
export interface SingleFlight<T> {
  /** key로 진행 중 실행을 공유하거나 새로 시작한다. */
  run(key: string, factory: () => Promise<T>): Promise<T>;
  /** 현재 진행 중인 key 수(관측/테스트용). */
  readonly size: number;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key, factory) {
      const existing = inflight.get(key);
      if (existing) return existing;
      // 동기 throw도 rejection이 되도록 microtask로 감싼다. 등록은 동기적으로 해서
      // 같은 tick의 동시 호출도 이 Promise를 공유한다(factory는 정확히 1회 실행).
      const p = Promise.resolve().then(factory).finally(() => {
        // 자기 자신일 때만 삭제(경합 방지: 이미 다른 실행이 대체했으면 건드리지 않음).
        if (inflight.get(key) === p) inflight.delete(key);
      });
      inflight.set(key, p);
      return p;
    },
    get size() {
      return inflight.size;
    },
  };
}
