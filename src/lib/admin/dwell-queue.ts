// Batched dwell queue, identity-bound (삼순 P1, 2026-08-30 #1323 리뷰 반영).
//
// 문제: 큐가 신원과 무관하게 쌓이면 A→B 계정 전환(로그아웃 null 경유 없이
// 직접 전환) 시 A의 대기 이벤트가 B의 토큰으로 서버 검증되어 A 체류가
// B user_id로 귀속된다. "user_id 서버 파생"은 이 레이스를 막지 못한다.
//
// 계약: 큐는 uid 스냅샷 하나에 결속된다.
// - setIdentity(다른 uid) → 기존 큐 fail-closed 폐기 (절대 새 uid로 귀속 금지)
// - setIdentity(같은 uid) → 큐 보존 (토큰 refresh는 같은 uid라 데이터 유지)
// - enqueue/drain 은 결속된 uid 와 일치할 때만 동작, 불일치는 폐기/드롭
//
// 순수 모듈(브라우저 API 없음) — QA 게이트가 node 에서 직접 실행해 회귀를
// 검증한다 (scripts/qa/dwell-batch-identity-smoke.ts).

export interface DwellQueuedEvent {
  path: string;
  dwellMs: number;
}

export const DWELL_FLUSH_INTERVAL_MS = 30_000;
export const DWELL_QUEUE_MAX = 20; // safety cap; flush early if a burst piles up
export const DWELL_MAX_MS = 30 * 60 * 1000; // single-interval cap (idle guard)

export type EnqueueResult = "queued" | "flush-now" | "dropped";

export class DwellQueue {
  private events: DwellQueuedEvent[] = [];
  private uid: string | null = null;

  /** Bind the queue to a (possibly new) identity. Switching to a different
   * uid discards everything queued under the old identity — fail-closed:
   * old events must never be attributed to the new uid. Returns true when
   * the identity actually changed (caller resets in-progress timing too). */
  setIdentity(uid: string | null): boolean {
    if (uid === this.uid) return false;
    this.events = [];
    this.uid = uid;
    return true;
  }

  get boundUid(): string | null {
    return this.uid;
  }

  get size(): number {
    return this.events.length;
  }

  /** Enqueue under the caller's uid. Dropped unless it matches the bound
   * identity (null identity ⇒ logged out ⇒ not tracked). Consecutive events
   * for the same path merge (visibility toggles), capped like a single
   * interval server-side.
   *
   * 삼순 P1 3차(#1323): 큐는 hard-bound — DWELL_QUEUE_MAX 이후 append 금지.
   * 토큰 대기 모드(flush가 이벤트를 보존하는 동안)에도 큐·payload가
   * 무제한 증가하지 않도록 과융분은 드롭하고 flush-now 신호만 낸다
   * (서버도 20개 초과를 버리므로 클라이언트에서 먼저 막는다). 같은 path
   * 연속 구간 merge는 append가 아니라 허용. */
  enqueue(uid: string | null, path: string, dwellMs: number): EnqueueResult {
    if (!uid || uid !== this.uid) return "dropped";
    const ms = Math.round(dwellMs);
    const last = this.events[this.events.length - 1];
    if (last && last.path === path) {
      last.dwellMs = Math.min(last.dwellMs + ms, DWELL_MAX_MS);
    } else {
      if (this.events.length >= DWELL_QUEUE_MAX) {
        return "flush-now"; // hard-bound: 새 이벤트 드롭, flush만 재촉구
      }
      this.events.push({ path, dwellMs: ms });
    }
    return this.events.length >= DWELL_QUEUE_MAX ? "flush-now" : "queued";
  }

  /** Take everything queued for the caller's uid. A mismatched uid gets
   * nothing AND clears the stale queue (fail-closed — those events belong to
   * an identity that no longer holds the session). */
  drain(uid: string | null): DwellQueuedEvent[] {
    if (!uid || uid !== this.uid) {
      this.events = [];
      return [];
    }
    const out = this.events;
    this.events = [];
    return out;
  }
}
