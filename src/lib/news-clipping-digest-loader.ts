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

export interface DigestLoaderOptions {
  /** 새 digest 가 들어왔을 때만 호출된다(불필요한 리렌더 방지). */
  onChange: (digests: Map<number, NewsClippingDigest>) => void;
  /**
   * **호출부가 소유하는 공유 캐시.** 로더는 이 Map 을 그대로 쓴다(복사하지 않는다).
   *
   * ⚠️ StrictMode(Next 16 App Router 기본)에서 effect 는 setup→cleanup→setup 으로 두 번 돈다.
   *    로더가 자기 Map 을 가지면 첫 로더의 응답이 버려져 재조회가 생기고, 재마운트마다
   *    같은 digest 를 다시 받아온다. 캐시를 밖에 두면 **폐기된 로더의 늦은 응답도 캐시에
   *    남아** 다음 로더가 그걸 이어받는다.
   */
  cache?: Map<number, NewsClippingDigest>;
  /** 테스트에서 가짜 타이머를 주입하기 위한 구멍. 기본은 전역 setTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  onError?: (message: string) => void;
}

export class NewsClippingDigestLoader {
  private digestMap: Map<number, NewsClippingDigest>;
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
    // 호출부가 공유 캐시를 주면 그걸 그대로 쓴고(복사 안 함), 없으면 자기 Map 을 갖는다.
    this.digestMap = options.cache ?? new Map();
  }

  /** 현재까지 확보한 digest. 호출부는 이 Map 을 그대로 렌더에 쓴다. */
  get digests(): Map<number, NewsClippingDigest> {
    return this.digestMap;
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
    // 새 id 가 없고 이미 굴러가고 있으면 아무것도 하지 않는다(겹침 방지).
    if (!added && (this.inFlight.size > 0 || this.timer !== null)) return;
    void this.pump();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  /** 아직 못 받았고, 요청 중도 아니고, 시도 상한도 안 넘긴 id. */
  private eligible(): number[] {
    const out: number[] = [];
    for (const id of this.wanted) {
      if (this.digestMap.has(id)) continue;
      if (this.inFlight.has(id)) continue;
      if ((this.attempts.get(id) ?? 0) >= DIGEST_MAX_ATTEMPTS) continue;
      out.push(id);
    }
    return out.sort((a, b) => a - b);
  }

  private async pump(): Promise<void> {
    if (this.disposed) return;
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
    let changed = false;
    for (const row of rows) {
      if (!ids.includes(row.id)) continue; // 요청하지 않은 행은 무시(응답 오염 방어)
      received.add(row.id);
      if (!this.notified.has(row.id)) changed = true;
      // ⚠️ dispose 됐어도 **캐시에는 쓴다.** 공유 캐시라 다음 로더(StrictMode 재-setup,
      //    재마운트)가 그걸 이어받는다. 상태 갱신(onChange)만 살아있을 때 한다.
      this.digestMap.set(row.id, row);
      this.attempts.delete(row.id);
    }
    // ⚠️ 부분 누락: 요청 3개 중 2개만 왔다면 나머지 1개만 실패로 센다. 성공분은 확정이다.
    for (const id of ids) {
      if (received.has(id)) continue;
      this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1);
    }

    // 언마운트 뒤에는 상태를 갱신하지 않는다. 다만 digestMap 은 이미 채워져 있으므로
    // 재마운트 시 재조회가 줄어든다.
    if (changed && !this.disposed) {
      for (const id of received) this.notified.add(id);
      this.options.onChange(new Map(this.digestMap));
    }

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
