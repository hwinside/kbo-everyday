/**
 * 폴백 이벤트 delta 버퍼 — DB **쓰기 횟수**를 줄인다.
 *
 * 왜 필요한가 (2026-08-20 삼순 blocker 1, 1차 리뷰)
 * ------------------------------------------------
 * 최초 설계는 이벤트마다 `UPSERT ... event_count + 1` 을 날렸다. 행 수는 138,708 → 수백으로
 * 줄지만 **DB 쓰기 횟수와 WAL 은 그대로**다. 오히려 같은 행을 계속 갱신하므로
 *   - `timestamp` 와 인덱스에 포함된 `event_count` 가 매번 바뀌어 HOT update 가 막히고
 *   - 경기 피크에 초당 13회가 같은 행에 몰려 hot-row lock contention 이 생긴다.
 *
 * 계약 (삼순 2차 리뷰 blocker 2·3 반영)
 * ------------------------------------
 * 1. **임계치까지는 즉시 durable.** 같은 키의 관측이 policy.threshold 에 도달하기 전까지는
 *    매 관측을 즉시 flush 한다. 그래야 "임계 3건이 2초 안에 오고 멈추면 경보가 안 나가는"
 *    구멍이 없다. 타이머 없는 버퍼는 "다음 관측"에 의존하는데, 장애가 끝나면 다음 관측이
 *    영영 안 온다 — 그게 정확히 경보가 필요한 순간이다.
 * 2. **임계 초과분부터 batch.** 임계를 넘긴 뒤에는 30초 창으로 모은다. 폭주 구간(초당 13회)이
 *    바로 이 구간이므로 쓰기 감소 효과는 그대로다.
 * 3. **take → ack/requeue.** drain 이 pending 을 지우고 끝나면 RPC 실패 시 delta 가 증발한다.
 *    이제 take 는 in-flight 로 옮기기만 하고, RPC 성공 시 ack(폐기) / 실패 시 requeue(복원)한다.
 *    `lastFlushedAt` 도 ack 시점에만 갱신한다 — 실패했는데 "방금 보냈다"고 기록하면
 *    다음 30초 동안 재시도가 막힌다.
 *
 * 알려진 한계 (숨기지 않는다)
 * ---------------------------
 *  - 서버리스 인스턴스가 flush 전에 죽으면 **임계 초과분 tail 이 유실된다.** 임계까지는 즉시
 *    durable 이므로 경보 판정과 "장애가 있었다"는 사실은 보존되고, 유실되는 것은 폭주 구간의
 *    "정확히 몇 번이었는지" 일부다. 카운트 정밀도와 쓰기 부하를 맞바꾼 결과다.
 *  - 인스턴스가 여러 개면 인스턴스마다 임계까지 즉시 쓰기가 발생한다. 총 쓰기 횟수는
 *    인스턴스 수에 비례하므로, 실제 감소폭은 배포 후 실측해야 한다(여기서 단정하지 않는다).
 */

export type FallbackReason = "timeout" | "http-error" | "schema-error" | "network-error";

export interface FallbackDelta {
  api_name: string;
  reason: FallbackReason | string;
  status_code: number | null;
  error_message: string | null;
  scope: string | null;
  fingerprint: string | null;
  count: number;
  window_minutes: number;
  threshold: number;
  cooldown_minutes: number;
  lease_seconds: number;
  /**
   * 이 delta 가 경보 claim 대상인가.
   *
   * trackApiDegradation(durable 경보 경로) = true — 서버가 임계 판정 후 attempt_token 을 준다.
   * trackFallback(legacy, in-memory 경보) = false — 기록만 한다.
   *
   * ⚠️ 삼순 blocker 3: 이 분리가 없으면 legacy 경로가 만든 outbox 를 아무도 settle 하지 않아
   *    outbox 가 남고, 기존 in-memory 경보와 drainer 가 중복 발송할 수 있다.
   */
  claim: boolean;
}

export interface FallbackObservation {
  apiName: string;
  reason: FallbackReason | string;
  statusCode?: number | null;
  errorMessage?: string | null;
  scope?: string | null;
  policy: {
    windowMinutes: number;
    threshold: number;
    cooldownMinutes: number;
    leaseSeconds: number;
  };
  /** 경보 claim 대상 여부. 기본 false(기록만). */
  claim?: boolean;
}

/** flush 주기. 삼순 권고 30~60초 중 하한. */
export const FLUSH_INTERVAL_MS = 30_000;

/**
 * 버퍼가 무한히 자라지 않게 하는 상한. 서로 다른 키가 이만큼 쌓이면 즉시 flush 한다.
 * (gameId × reason × fingerprint 조합이 폭발하는 병리적 상황 방어)
 */
export const MAX_PENDING_KEYS = 200;

/**
 * 오류 지문 — 같은 분·같은 reason 이라도 서로 다른 오류가 한 행으로 뭉개지지 않게 한다
 * (삼순 1차 blocker 4). 숫자·UUID·gameId 처럼 매 호출 달라지는 부분을 지운 뒤 해시한다.
 */
export function fingerprintOf(message: string | null | undefined): string | null {
  if (!message) return null;
  const normalized = message
    .replace(/\b\d{8}[A-Z]{4}\d\b/g, "<gameid>") // 20260819HTHH0
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d+/g, "<n>")
    .trim()
    .slice(0, 300);
  // FNV-1a 32bit — 충돌 확률보다 "결정론·짧음"이 중요하다(지문이지 보안 해시가 아니다).
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function keyOf(o: FallbackObservation, fingerprint: string | null): string {
  return [o.apiName, o.reason, o.scope ?? "", fingerprint ?? "", o.claim ? "c" : "r"].join("\u0000");
}

interface PendingEntry extends FallbackDelta {
  key: string;
}

/** 프로세스 로컬 버퍼. 서버리스 인스턴스 수명 동안만 유효하며, 그게 이 설계의 전제다. */
const pending = new Map<string, PendingEntry>();
/** take 로 꺼냈지만 아직 ack 되지 않은 delta — RPC 실패 시 여기서 복원한다. */
const inFlight = new Map<string, PendingEntry>();
/** 키별 마지막 **성공** flush 시각. ack 시점에만 갱신한다. */
const lastFlushedAt = new Map<string, number>();
/** 키별 durable 로 확정된 누적 관측 수 — 임계 도달 여부 판정에 쓴다. */
const durableCount = new Map<string, number>();

let nowFn: () => number = () => Date.now();

/** 테스트 전용 — 결정론적 시계 주입. 프로덕션 경로에서는 호출하지 않는다. */
export function __setClockForTest(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

/** 테스트 전용 — 프로세스 상태 초기화. */
export function __resetBufferForTest(): void {
  pending.clear();
  inFlight.clear();
  lastFlushedAt.clear();
  durableCount.clear();
}

export function pendingKeyCountForTest(): number {
  return pending.size;
}

export function inFlightKeyCountForTest(): number {
  return inFlight.size;
}

/**
 * 관측 1건을 버퍼에 넣는다. 지금 flush 해야 하면 true 를 돌려준다.
 *
 * 반환값이 true 여도 이 함수는 아무것도 쓰지 않는다 — I/O 는 호출부(`after()` 안)가 한다.
 * 순수 함수로 두어야 버퍼 계약을 결정론적으로 테스트할 수 있다.
 */
export function observeFallback(o: FallbackObservation): boolean {
  const fingerprint = fingerprintOf(o.errorMessage);
  const key = keyOf(o, fingerprint);
  const now = nowFn();

  const existing = pending.get(key);
  if (existing) {
    existing.count += 1;
    // 마지막 관측의 상세를 남긴다(같은 지문이므로 의미는 같다).
    existing.status_code = o.statusCode ?? existing.status_code;
    existing.error_message = o.errorMessage ?? existing.error_message;
  } else {
    pending.set(key, {
      key,
      api_name: o.apiName,
      reason: o.reason,
      status_code: o.statusCode ?? null,
      error_message: o.errorMessage ?? null,
      scope: o.scope ?? null,
      fingerprint,
      count: 1,
      window_minutes: o.policy.windowMinutes,
      threshold: o.policy.threshold,
      cooldown_minutes: o.policy.cooldownMinutes,
      lease_seconds: o.policy.leaseSeconds,
      claim: o.claim === true,
    });
  }

  // ① 임계치까지는 즉시 durable (삼순 blocker 2).
  //    타이머가 없으므로 "다음 관측이 온다"에 기댈 수 없다. 장애가 임계 근처에서 멈추면
  //    다음 관측이 영영 안 오고, 그게 정확히 경보가 필요한 순간이다.
  //    durableCount 는 ack 된 것만 세므로, RPC 가 실패하는 동안에는 계속 즉시 flush 를 시도한다.
  const confirmed = durableCount.get(key) ?? 0;
  const buffered = pending.get(key)?.count ?? 0;
  if (confirmed + buffered <= o.policy.threshold) return true;

  // ② 버퍼 폭주 방어
  if (pending.size >= MAX_PENDING_KEYS) return true;

  // ③ 주기 도달 (마지막 **성공** flush 기준)
  const lastFlush = lastFlushedAt.get(key);
  if (lastFlush === undefined) return true;
  return now - lastFlush >= FLUSH_INTERVAL_MS;
}

/**
 * 누적된 delta 를 꺼내 in-flight 로 옮긴다. 버퍼에서는 사라지지만 **아직 확정이 아니다** —
 * 호출부는 RPC 성공 시 ackFallbackFlush(), 실패 시 requeueFallbackFlush() 를 반드시 불러야 한다.
 *
 * ⚠️ 삼순 blocker 3: 종전 drainFallbackBuffer() 는 여기서 pending 을 지우고 lastFlushedAt 까지
 *    갱신했다. RPC 가 실패하면 첫 관측을 포함한 delta 가 그대로 증발했고, "방금 보냈다"고
 *    기록돼 다음 30초 동안 재시도도 막혔다.
 */
export function takeFallbackBuffer(): FallbackDelta[] {
  if (pending.size === 0) return [];
  const out: FallbackDelta[] = [];
  for (const entry of pending.values()) {
    // 같은 키가 이미 in-flight 라면 합쳐서 중복 왕복을 만들지 않는다.
    const prev = inFlight.get(entry.key);
    if (prev) prev.count += entry.count;
    else inFlight.set(entry.key, { ...entry });

    const { key: _key, ...delta } = entry;
    void _key;
    out.push(delta);
  }
  pending.clear();
  return out;
}

/** RPC 성공 — in-flight 를 폐기하고 성공 시각·durable 카운트를 확정한다. */
export function ackFallbackFlush(deltas: FallbackDelta[]): void {
  const now = nowFn();
  for (const d of deltas) {
    const key = deltaKey(d);
    const entry = inFlight.get(key);
    if (!entry) continue;
    inFlight.delete(key);
    lastFlushedAt.set(key, now);
    durableCount.set(key, (durableCount.get(key) ?? 0) + entry.count);
  }
}

/**
 * RPC 실패 — in-flight 를 pending 으로 되돌린다. lastFlushedAt 은 건드리지 않으므로
 * 다음 관측에서 즉시 재시도된다.
 */
export function requeueFallbackFlush(deltas: FallbackDelta[]): void {
  for (const d of deltas) {
    const key = deltaKey(d);
    const entry = inFlight.get(key);
    if (!entry) continue;
    inFlight.delete(key);
    const cur = pending.get(key);
    if (cur) cur.count += entry.count;
    else pending.set(key, entry);
  }
}

function deltaKey(d: FallbackDelta): string {
  return [d.api_name, d.reason, d.scope ?? "", d.fingerprint ?? "", d.claim ? "c" : "r"].join("\u0000");
}
