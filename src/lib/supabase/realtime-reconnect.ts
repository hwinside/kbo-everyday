/**
 * Realtime 채널 재연결 백오프/재구독 판정 순수 헬퍼.
 *
 * 배경(2026-07-28 P0): 라이브 경기 피크(18~22 KST)에 Supabase Realtime 구독풀
 * `Too many database timeouts` 4,274건. 근본 증폭원 = `useChat` 재구독 폭주 —
 * (1) CHANNEL_ERROR/TIMED_OUT/CLOSED 에 **고정 1초** 재시도라 서비스 열화 시 모든
 * 클라이언트가 1초마다 lockstep 재시도 → 열화된 Realtime 을 더 때리는 양의 피드백,
 * (2) visibility 복귀 시 **정상 채널까지 즉시 재구독**해 join storm(53.5/s) 가중.
 *
 * 해법: 지수 백오프 + jitter + 상한(circuit breaker)으로 재시도 폭주를 눌러 herd 를
 * 분산하고, 재구독은 채널이 실제로 죽었을 때만 한다. 로직을 Response/Effect 와 분리해
 * 결정론적으로 테스트한다(random 주입).
 */

export interface ReconnectBackoffOptions {
  /** 최초 백오프(attempt=0)의 기준값. 기본 1000ms. */
  baseMs?: number;
  /** 백오프 상한(circuit breaker). 기본 30000ms. */
  maxMs?: number;
  /** [0, jitterMs) 균등 jitter 폭. herd 분산용. 기본 1000ms. */
  jitterMs?: number;
  /** [0,1) 난수 주입(테스트 결정성). 기본 Math.random. */
  random?: () => number;
}

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 30000;
const DEFAULT_JITTER_MS = 1000;

/**
 * 지수 백오프 + jitter 재연결 지연(ms)을 계산한다.
 * delay = min(base * 2^attempt, max) + random()*jitter.
 * attempt 는 0부터(첫 실패=0 → base 근처, 반복 실패마다 2배씩 상한까지).
 * 상한 도달 후엔 max 로 고정돼 지속 열화에도 클라이언트당 재시도 주기가 max 로 수렴한다.
 */
export function computeReconnectDelay(attempt: number, opts?: ReconnectBackoffOptions): number {
  const base = opts?.baseMs ?? DEFAULT_BASE_MS;
  const max = opts?.maxMs ?? DEFAULT_MAX_MS;
  const jitter = opts?.jitterMs ?? DEFAULT_JITTER_MS;
  const rnd = opts?.random ?? Math.random;
  // 음수/NaN/소수 attempt 방어. 2^31 이상은 Infinity/오버플로우 → max 고정.
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const exp = safeAttempt >= 31 ? max : Math.min(base * 2 ** safeAttempt, max);
  return exp + rnd() * jitter;
}

/**
 * visibility(탭 복귀)/online 시 재구독을 해야 하는가.
 * 채널이 이미 살아있으면(subscribed) 재구독하지 않는다 — 정상 채널 재구독 storm 차단.
 * 이미 예약된 재연결이 있으면(hasPendingReconnect) 중복 예약하지 않는다.
 * (backfill 은 이 판정과 무관하게 항상 수행돼 REST 로 누락분을 즉시 메운다.)
 */
export function shouldResubscribeOnVisible(
  subscribed: boolean,
  hasPendingReconnect: boolean,
  hasActiveChannel = subscribed,
): boolean {
  return !subscribed && !hasPendingReconnect && !hasActiveChannel;
}
