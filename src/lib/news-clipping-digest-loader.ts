// 참조형 뉴스클리핑 쪽지(payload.digest_id)가 가리키는 기사 묶음 로더 — React 밖의 순수 로직.
//
// ⚠️ 삼순 blocker 1 (2026-08-20, 3차): 재시도가 ref 만 갱신하고 state·timer 를 안 건드려
//    `[wantedKey, fetchDigests]` effect 가 다시 돌지 않았다. 즉 **실패는 기록됐지만 재시도는
//    한 번도 일어나지 않았다** — 조용한 대화(새 메시지가 안 들어오는 대화)는 1회 실패 뒤
//    영원히 텍스트로 남는다. 리렌더가 재시도의 유일한 트리거였던 셈이다.
//
// 그래서 스케줄링을 훅 밖으로 꺼낸다. 이유는 두 가지다:
//   1) 재시도를 **자기 타이머**로 소유한다 — 리렌더에 의존하지 않는다.
//   2) hook 을 렌더링하지 않고도 요청 겹침·부분 누락·실패→backoff 를 **직접 테스트**할 수 있다.
//      (39-check 가 hook 을 안 읽는다는 지적이 여기서 닫힌다.)

import type { NewsClippingDigest } from "@/types/news-clipping";

/** 같은 id 를 계속 두드리지 않도록 하는 상한. 넘으면 그 세션에서는 텍스트로 렌더된다. */
export const DIGEST_MAX_ATTEMPTS = 3;
/** 첫 재시도까지의 대기(ms). 이후 지수 백오프. */
export const DIGEST_RETRY_BASE_MS = 500;

/** attempt(1-based 실패 횟수) → 다음 재시도까지 대기 ms. 500 / 1000 / 2000. */
export function digestRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return DIGEST_RETRY_BASE_MS * 2 ** (n - 1);
}

export interface DigestFetchResult {
  rows: NewsClippingDigest[];
  error?: string;
}

/** id 배열을 받아 digest 행을 돌려주는 함수. 실패는 throw 하거나 error 를 채운다. */
export type DigestFetcher = (ids: number[]) => Promise<DigestFetchResult>;

/**
 * 로더 수명을 넘어 살아남는 digest 캐시. **변경을 토하는 스토어**다.
 *
 * ⚠️ 삼순 blocker (6차, 2026-08-20): 단순 Map 을 공유하면 **terminal race** 가 남는다.
 *    B(현재 로더)가 3회 시도를 모두 소진해 timer=null 이 된 뒤에 A(폐기된 로더)가 성공하면,
 *    A 는 Map 에만 쓰고 B 는 request/pump/flushCached 가 다시 호출되지 않아
 *    **state 0 이 영원히 유지된다**(카드가 텍스트로 굳는다).
 *    5차의 flushCached() 는 "다시 토해지는 시점"이 있을 때만 유효했다.
 *    → 캐시 자승이 구독자에게 알리게 해서, 쓰는 쪽이 도달을 밀어준다(push).
 *    폴링 타이머나 "dispose 로더의 write 금지"(=A 의 성공을 버림) 대심 구조로 해결한다.
 */
export class NewsClippingDigestCache {
  private readonly map = new Map<number, NewsClippingDigest>();
  private readonly listeners = new Set<(id: number) => void>();

  get size(): number {
    return this.map.size;
  }
  has(id: number): boolean {
    return this.map.has(id);
  }
  get(id: number): NewsClippingDigest | undefined {
    return this.map.get(id);
  }
  snapshot(): Map<number, NewsClippingDigest> {
    return new Map(this.map);
  }

  /** 로더가 받은 행을 쓴다. **쓰기 자체가 구독자를 깨운다.** */
  set(id: number, row: NewsClippingDigest): void {
    const isNew = !this.map.has(id);
    this.map.set(id, row);
    if (!isNew) return;
    // 리스너 안에서 국독이 변할 수 있으므로 사본을 순회한다.
    for (const fn of [...this.listeners]) fn(id);
  }

  /** 캐시에 새 행이 들어오면 토해달라고 든다. 반환값은 구독 해지 함수. */
  subscribe(fn: (id: number) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 테스트/관족용 — 구독자 수(누수 감지). */
  listenerCountForTest(): number {
    return this.listeners.size;
  }
}

export interface DigestLoaderOptions {
  /** 새 digest 가 들어왔을 때만 호출된다(불필요한 리렌더 방지). */
  onChange: (digests: Map<number, NewsClippingDigest>) => void;
  /**
   * **호출부가 소유하는 공유 캐시.** 로더는 이 스토어를 국독한다.
   *
   * ⚠️ StrictMode(Next 16 App Router 기본)에서 effect 는 setup→cleanup→setup 으로 두 번 돈다.
   *    로더가 자기 Map 을 가지면 첫 로더의 응답이 버려져 재조회가 생기고, 재마운트마다
   *    같은 digest 를 다시 받아온다. 캐시를 밖에 두면 **폐기된 로더의 늦은 응답도 캐시에
   *    남아** 다음 로더가 그걸 이어받는다.
   */
  cache?: NewsClippingDigestCache;
  /** 테스트에서 가짜 타이머를 주입하기 위한 구멍. 기본은 전역 setTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  onError?: (message: string) => void;
}

export class NewsClippingDigestLoader {
  private readonly cache: NewsClippingDigestCache;
  private unsubscribe: (() => void) | null = null;
  /**
   * **내가 캐시에 쓰는 동안** 구독 알림을 억제한다.
   *
   * ⚠️ 6차에 캐시 구독을 달자 배치가 깨졌다: 한 번의 조회로 id 2개를 받으면 cache.set 이
   *    두 번 일어나고 그때마다 구독이 깨어 **같은 조회에 onChange 가 2회** 발생한다
   *    (스모크 8-9 가 잡았다 — 불필요한 리렌더).
   *    내 쓰기는 pump 끝의 flushCached() 한 번으로 배치해 알리고, 구독은
   *    **다른 로더의 쓰기**를 받는 용도로만 남긴다(terminal race 방어).
   */
  private writingOwnRows = false;
  private wanted = new Set<number>();
  private inFlight = new Set<number>();
  /** id 별 누적 실패 횟수. 성공하면 지운다. */
  private attempts = new Map<number, number>();
  /**
   * **이 로더가** 호출부에 알린 id.
   *
   * ⚠️ 캐시를 공유하면 "map 에 이미 있다"를 변경 없음으로 읽을 수 없다 — StrictMode 에서
   *    폐기된 로더가 먼저 캐시를 채우면 살아있는 로더가 "바뀜 게 없다"고 판단해
   *    onChange 를 안 불러 **화면이 영원히 빈다**(4차 수정 중 실측으로 발견).
   *    그래서 기준을 "내가 알렸는가"로 바꿄다.
   */
  private notified = new Set<number>();
  private timer: unknown = null;
  private disposed = false;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(
    private readonly fetcher: DigestFetcher,
    private readonly options: DigestLoaderOptions,
  ) {
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    // 호출부가 공유 캐시를 주면 그걸 쓰고, 없으면 자기 스토어를 갖는다.
    this.cache = options.cache ?? new NewsClippingDigestCache();
    // ⚠️ terminal race 방어(6차): 다른 로더가 캐시를 채우면 **그 쓰기가** 우리를 깨운다.
    //    내 재시도가 모든 소진되어 timer 가 없어도 도달이 보장된다.
    this.unsubscribe = this.cache.subscribe((id) => {
      if (this.disposed) return;
      // 내 조회 결과를 쓰는 중이면 여기서 알리지 않는다 — pump 끝에서 한 번에 배치한다.
      if (this.writingOwnRows) return;
      if (!this.wanted.has(id)) return;
      this.flushCached();
    });
  }

  /** 현재까지 확보한 digest 스냅샷. */
  get digests(): Map<number, NewsClippingDigest> {
    return this.cache.snapshot();
  }

  /** 테스트/관측용 — 이 id 가 몇 번 실패했나. */
  attemptsOf(id: number): number {
    return this.attempts.get(id) ?? 0;
  }

  /** 테스트/관측용 — 지금 요청 중인 id. */
  inFlightIds(): number[] {
    return [...this.inFlight].sort((a, b) => a - b);
  }

  /** 테스트/관측용 — 재시도 타이머가 걸려 있나. */
  hasPendingRetry(): boolean {
    return this.timer !== null;
  }

  /** 화면에 필요한 digest_id 집합을 알린다. 이미 받은 id 는 다시 조회하지 않는다. */
  request(ids: number[]): void {
    if (this.disposed) return;
    let added = false;
    for (const id of ids) {
      if (!Number.isFinite(id) || id <= 0) continue;
      if (!this.wanted.has(id)) {
        this.wanted.add(id);
        added = true;
      }
    }
    // 캐시에 이미 있는 id 를 먼저 털어낸다 — 조회를 안 해도 호출부는 알아야 한다.
    this.flushCached();
    // 새 id 가 없고 이미 굴러가고 있으면 아무것도 하지 않는다(겹침 방지).
    if (!added && (this.inFlight.size > 0 || this.timer !== null)) return;
    void this.pump();
  }

  /**
   * **캐시에는 있지만 아직 호출부에 알리지 않은** id 를 털어낸다.
   *
   * ⚠️ 삼순 blocker (5차, 2026-08-20): 공유 캐시를 도입하자 **반대 순서 race** 가 생겼다.
   *    StrictMode 에서 폐기된 로더 A 가 성공해 캐시만 채우고(A 는 dispose 돼 onChange 못 함),
   *    현재 로더 B 가 실패하면 — B 는 받은 행이 없으니 changed=false, 그러므로 onChange 도 안 부르고,
   *    다음 eligible() 은 `digestMap.has(id)` 로 재시도를 멈췄다. 결과: 캐시엔 있는데 state 는 0 —
   *    **카드가 영원히 안 뜨고 텍스트로 남는다.**
   *    캐시를 버리면(=A 의 성공을 버리면) 재조회가 늘고 깜박임이 생기므로,
   *    **캐시 히트도 알림 대상**으로 삼아 소유권을 보장하는 쪽을 택했다.
   */
  private flushCached(): boolean {
    if (this.disposed) return false;
    let changed = false;
    for (const id of this.wanted) {
      if (!this.cache.has(id)) continue;
      if (this.notified.has(id)) continue;
      this.notified.add(id);
      this.attempts.delete(id);
      changed = true;
    }
    if (changed) this.options.onChange(this.cache.snapshot());
    return changed;
  }

  dispose(): void {
    this.disposed = true;
    // 국독을 도려줘야 폐기된 로더가 캐시 이벤트를 불잡지 않는다(리스너 누수 방지).
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  /** 아직 못 받았고, 요청 중도 아니고, 시도 상한도 안 넘긴 id. */
  private eligible(): number[] {
    const out: number[] = [];
    for (const id of this.wanted) {
      if (this.cache.has(id)) continue;
      if (this.inFlight.has(id)) continue;
      if ((this.attempts.get(id) ?? 0) >= DIGEST_MAX_ATTEMPTS) continue;
      out.push(id);
    }
    return out.sort((a, b) => a - b);
  }

  private async pump(): Promise<void> {
    if (this.disposed) return;
    // 조회 전에 캐시 히트분을 먼저 털어낸다(다른 로더가 채워둔 것).
    this.flushCached();
    const ids = this.eligible();
    if (ids.length === 0) return;
    for (const id of ids) this.inFlight.add(id);

    let rows: NewsClippingDigest[] = [];
    try {
      const res = await this.fetcher(ids);
      if (res?.error) {
        this.options.onError?.(res.error);
      }
      rows = (res?.rows ?? []).filter(
        (row) => !!row && Array.isArray(row.articles) && row.articles.length > 0,
      );
    } catch (e) {
      this.options.onError?.((e as Error)?.message ?? "unknown");
      rows = [];
    } finally {
      for (const id of ids) this.inFlight.delete(id);
    }

    const received = new Set<number>();
    this.writingOwnRows = true;
    try {
      for (const row of rows) {
        if (!ids.includes(row.id)) continue; // 요청하지 않은 행은 무시(응답 오염 방어)
        received.add(row.id);
        // ⚠️ dispose 됐어도 **캐시에는 쓴다.** 공유 캐시라 다음 로더(StrictMode 재-setup,
        //    재마운트)가 그걸 이어받고, 쓰기가 구독자를 깨워 살아있는 로더에 도달된다.
        this.cache.set(row.id, row);
        this.attempts.delete(row.id);
      }
    } finally {
      this.writingOwnRows = false;
    }
    // ⚠️ 부분 누락: 요청 3개 중 2개만 왔다면 나머지 1개만 실패로 센다. 성공분은 확정이다.
    for (const id of ids) {
      if (received.has(id)) continue;
      this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1);
    }

    // ⚠️ 알림 경로는 **flushCached() 하나로 통합**한다.
    //    6차에 캐시 구독을 달았는데, 여기서 또 onChange 를 부르면 cache.set 이 깨운
    //    flushCached 와 겹쳐 **같은 데이터로 onChange 가 2회** 발생한다(불필요한 리렌더).
    //    스모크 8-1 이 그걸 잡았다 — 기대값을 낮추는 대신 경로를 합쳤다.
    //    dispose 상태면 flushCached 가 자체 거부하므로 언마운트 후 상태 갱신도 없다.
    //    조회하는 사이 다른 로더가 채운 분까지 이 한 번에 다 털린다(반대 순서 race).
    this.flushCached();

    this.scheduleRetry();
  }

  /**
   * 남은 id 가 있으면 **타이머로** 재시도를 예약한다.
   * 이 한 줄이 blocker 1 의 본질 — 재시도를 리렌더에 위임하지 않는다.
   */
  private scheduleRetry(): void {
    if (this.disposed || this.timer !== null) return;
    const pending = this.eligible();
    if (pending.length === 0) return;
    const minAttempt = Math.min(...pending.map((id) => this.attempts.get(id) ?? 0));
    const delay = digestRetryDelayMs(Math.max(1, minAttempt));
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.pump();
    }, delay);
  }
}
