/**
 * 폴백 이벤트 delta 버퍼 — DB **쓰기 횟수**를 줄인다.
 *
 * 왜 필요한가 (2026-08-20 삼순 blocker 1)
 * ------------------------------------------------
 * 1차 설계는 이벤트마다 `UPSERT ... event_count + 1` 을 날렸다. 행 수는 138,708 → 수백으로
 * 줄지만 **DB 쓰기 횟수와 WAL 은 그대로**다. 오히려 같은 행을 계속 갱신하므로
 *   - `timestamp` 와 인덱스에 포함된 `event_count` 가 매번 바뀌어 HOT update 가 막히고
 *   - 경기 피크에 초당 13회가 같은 행에 몰려 hot-row lock contention 이 생긴다.
 * "디스크만 보고 쓰기 부하도 줄었다"고 넘어가면 안 되는 지점이었다.
 *
 * 그래서 진짜 해법은 **앱 프로세스 안에서 delta 를 모아 주기적으로 1회 flush** 하는 것이다.
 *
 * 계약
 * ----
 *  - 같은 키의 **첫 관측은 즉시 flush** 한다. 경보 임계 판정이 30초씩 늦어지면 안 되기 때문이다.
 *  - 그 뒤 같은 키의 관측은 메모리에 누적되고, `FLUSH_INTERVAL_MS` 가 지난 다음 관측에서 함께 나간다.
 *  - 즉 N 건 버스트가 `1 + ceil(지속시간/30s)` 회 쓰기가 된다.
 *
 * 알려진 한계 (숨기지 않는다)
 * ---------------------------
 *  - 서버리스 인스턴스가 flush 전에 죽으면 **누적분 tail 이 유실된다.** 이건 카운트 정확도를
 *    쓰기 부하와 맞바꾼 것이다. 첫 관측은 항상 즉시 나가므로 "장애가 있었다는 사실"은 남고,
 *    유실되는 것은 "몇 번이었는지"의 일부다.
 *  - 인스턴스가 여러 개면 인스턴스마다 첫 관측 1회가 나간다. 총 쓰기 횟수는 인스턴스 수에
 *    비례하므로, 실제 감소폭은 배포 후 실측해야 한다(여기서 단정하지 않는다).
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
 * (삼순 blocker 4). 숫자·UUID·따옴표 안 값처럼 매 호출 달라지는 부분을 지운 뒤 해시한다.
 *
 * 해시가 아니라 정규화 문자열을 그대로 쓰면 컬럼이 길어지므로 짧은 안정 해시를 쓴다.
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
  return `${o.apiName}\u0000${o.reason}\u0000${o.scope ?? ""}\u0000${fingerprint ?? ""}`;
}

interface PendingEntry extends FallbackDelta {
  key: string;
}

/**
 * 프로세스 로컬 버퍼. 서버리스 인스턴스 수명 동안만 유효하며, 그게 이 설계의 전제다.
 * (durable 큐를 쓰면 그 큐 쓰기가 다시 같은 문제를 만든다.)
 */
const pending = new Map<string, PendingEntry>();
/** 키별 마지막 flush 시각 — "첫 관측 즉시 flush" 와 주기 flush 판정에 쓴다. */
const lastFlushedAt = new Map<string, number>();

let nowFn: () => number = () => Date.now();

/** 테스트 전용 — 결정론적 시계 주입. 프로덕션 경로에서는 호출하지 않는다. */
export function __setClockForTest(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

/** 테스트 전용 — 프로세스 상태 초기화. */
export function __resetBufferForTest(): void {
  pending.clear();
  lastFlushedAt.clear();
}

export function pendingKeyCountForTest(): number {
  return pending.size;
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
    });
  }

  // ① 이 프로세스에서 처음 보는 키 → 즉시 flush. 경보 임계 판정을 늦추지 않기 위함.
  const lastFlush = lastFlushedAt.get(key);
  if (lastFlush === undefined) return true;

  // ② 버퍼 폭주 방어
  if (pending.size >= MAX_PENDING_KEYS) return true;

  // ③ 주기 도달
  return now - lastFlush >= FLUSH_INTERVAL_MS;
}

/**
 * 누적된 delta 를 꺼내고 버퍼를 비운다. 호출부가 이 배열을 1회 RPC 로 보낸다.
 * 비어 있으면 빈 배열.
 */
export function drainFallbackBuffer(): FallbackDelta[] {
  if (pending.size === 0) return [];
  const now = nowFn();
  const out: FallbackDelta[] = [];
  for (const entry of pending.values()) {
    lastFlushedAt.set(entry.key, now);
    const { key: _key, ...delta } = entry;
    void _key;
    out.push(delta);
  }
  pending.clear();
  return out;
}
