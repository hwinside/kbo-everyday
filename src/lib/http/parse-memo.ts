/**
 * raw content-hash bounded memoize (Fluid Active CPU 절감 — 삼순 A안).
 *
 * ── 무엇을 접나 ─────────────────────────────────────────────────────────
 * upstream *raw fetch* 는 매 요청 그대로 두고(최신성 유지), **동일한 raw 입력의 순수
 * 파싱/집계만** 재사용한다. 같은 경기를 여러 시청자가 30s 폴링할 때 KBO upstream 은 이미
 * `next: { revalidate }` 로 캐시돼 동시 요청이 byte-identical raw 를 받으므로, 그 raw 를
 * 다시 파싱하는 CPU 만 1회로 접는다. warm instance 내부 CPU 만 줄이며 Function/Edge
 * invocation 은 줄이지 않는다.
 *
 * ── 왜 staleness 0 인가 ─────────────────────────────────────────────────
 * 키가 raw content 자체다. raw 가 바뀌면(점수 전이 등) 키가 바뀌어 **즉시 재계산**한다.
 * TTL 도, 시간 기반 공유도 없다. 따라서 follower 가 낡은 스냅샷을 받는 일이 없다
 * (full-route single-flight 의 `sourceAtMs` 공유 결함과 다르다).
 *
 * ── mutation 격리 ──────────────────────────────────────────────────────
 * 캐시된 결과가 downstream 에서 변형돼 다음 히트가 오염되는 것을 막기 위해 저장/반환 모두
 * deepFreeze 한다. 파서는 순수하지만(입력 mutate 없음) 결과 객체를 downstream 이 변형할
 * 가능성을 원천 차단한다. 결과가 freeze 되면 안 되는 파서는 이 memoize 를 쓰지 않는다.
 *
 * ── bounded ────────────────────────────────────────────────────────────
 * Map 을 insertion-order LRU 로 쓴다(히트 시 재삽입으로 recency 갱신). 상한 초과 시 가장
 * 오래된 엔트리부터 제거. 상한은 생성 시 고정.
 */

export interface ParseMemo<In, Out> {
  (input: In): Out;
  /** 관측/테스트용 현재 엔트리 수. */
  readonly size: number;
}

/** 원시 값 재귀 동결(배열/객체). 이미 frozen 이면 건너뛴다. 순환 없음 가정(파싱 결과 JSON). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * 결정론적 content hash. JSON.stringify 는 키 순서에 민감하지만, 같은 upstream 응답은
 * 같은 직렬화를 내므로(동일 소스·동일 스키마) 동시 요청 공유 목적에는 충분하다.
 * 충돌 시에도 안전: hash 가 같아도 저장된 raw 원본과 `===`(참조) 또는 직렬화 재확인으로
 * 오적용을 막는다.
 */
function hashOf(serialized: string): string {
  // FNV-1a 32bit — 짧고 빠르며 동시 폴링 규모에 충분.
  let h = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i += 1) {
    h ^= serialized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ":" + serialized.length;
}

/**
 * 순수 파서 `fn` 을 raw content-hash 로 memoize 한다.
 *
 * @param fn        순수 함수(입력 mutate 금지, 결정론적).
 * @param maxSize   최대 캐시 엔트리 수(LRU eviction).
 */
export function memoizeByContentHash<In, Out>(
  fn: (input: In) => Out,
  maxSize = 64,
): ParseMemo<In, Out> {
  const cache = new Map<string, { serialized: string; result: Out }>();

  const memo = ((input: In): Out => {
    let serialized: string;
    try {
      serialized = JSON.stringify(input);
    } catch {
      // 직렬화 불가(순환 등)면 memoize 우회 — 정확성 우선.
      return fn(input);
    }
    const key = hashOf(serialized);
    const hit = cache.get(key);
    if (hit && hit.serialized === serialized) {
      // recency 갱신(LRU): 재삽입으로 최근 사용 표시.
      cache.delete(key);
      cache.set(key, hit);
      return hit.result;
    }
    // MISS 또는 hash 충돌(serialized 불일치) → 재계산. 충돌 시 최신 raw 로 덮어쓴다.
    const result = deepFreeze(fn(input));
    cache.set(key, { serialized, result });
    while (cache.size > maxSize) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return result;
  }) as ParseMemo<In, Out>;

  Object.defineProperty(memo, "size", { get: () => cache.size });
  return memo;
}
