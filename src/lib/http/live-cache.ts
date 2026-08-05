/**
 * 라이브 API 엣지 캐시 계약 (SSOT).
 *
 * 왜 한 곳에 모으나: 외부 데이터 소스 failover 사고(7/30 P0)와 같은 축이다.
 * 캐시 정책이 route 별로 흩어지면 한 곳만 고치고 "적용 완료"로 오판한다.
 * 모든 라이브 route 는 이 모듈의 헬퍼만 쓰고, 직접 Cache-Control 문자열을
 * 만들지 않는다.
 *
 * ── 신선도 계약 (활성 유저 신선도 저하 0) ────────────────────────────────
 * `stale-while-revalidate` 를 쓰지 않는다. SWR 은 TTL 이 끝난 뒤에도 낡은
 * 응답을 계속 내보내므로 최대 staleness 가 TTL 을 넘어간다 = 신선도 저하.
 * 여기서는 max staleness == TTL 로 정확히 묶는다.
 *
 * relay TTL 2초는 임의값이 아니라 `game-relay` 가 이미 프로세스 내부에서
 * 쓰고 있는 CACHE_TTL_MS(2,000ms) 와 **같은 값**이다. 이 동치는 주석이 아니라
 * 코드로 강제한다 — route 는 `RELAY_EDGE_TTL_SECONDS` 에서 CACHE_TTL_MS 를
 * 파생시키므로(단일 owner) 한쪽만 바뀌는 drift 가 불가능하다.
 *
 * ── 직렬 누적(age) 차단 ─────────────────────────────────────────────────
 * ⚠️ 삼순 NO-GO(2026-08-06): route 내부 캐시 2초와 엣지 2초는 **직렬**이다.
 * route-cache 가 만료 직전(예: 남은 수명 0.1초)인 snapshot 으로 엣지 MISS 를
 * 채우면, 그 snapshot 이 엣지에서 다시 2초 살아 있어 유저가 보는 age 가 최대
 * ~4초까지 늘어난다. 즉 "TTL 동일 = 지연 상한 동일" 이 성립하지 않았다.
 *
 * → cache HIT 응답은 **남은 수명(remaining lifetime)만큼만** 엣지 TTL 을 준다.
 *   `edgeCacheHeadersForRemaining()` 이 그 계산을 맡고, 남은 수명이 1초 미만이면
 *   캐시하지 않는다(no-store). 이러면 총 age 상한이 route TTL 하나로 묶인다.
 *
 * ── 적용 대상 계약 (삼순 NO-GO 2026-08-06 ①) ────────────────────────────
 * ⚠️ **동등한 내부 TTL 이 이미 있는 route 에만 엣지 캐시를 붙인다.**
 *
 * relay 는 원래부터 프로세스 내부 2초 캐시가 있었다. 그래서 엣지 2초는 새로운
 * 지연을 만들지 않고, 같은 2초를 여러 lambda 가 각자 감당하던 것을 엣지가 한 번
 * 감당하도록 바꾸는 것뿐이다(신선도 저하 0).
 *
 * 반면 `game-live`·`contextual-stats` 는 그런 내부 TTL 이 **없다**. 여기에
 * s-maxage 를 새로 붙이면 점수·이닝·볼카운트·현재 타석이 그 TTL 만큼 **실제로 더
 * 낡아진다** — 이는 "활성 유저 신선도 저하 0" 하드 제약 위반이다.
 * 처음 이 모듈은 두 route 에도 5초를 붙였고, 그건 틀렸다.
 *
 * → 이 두 route 는 엣지 캐시 대상이 아니며 항상 no-store 다. 이들에 엣지 캐시를
 *   붙이려면 먼저 route 내부 TTL 을 도입해 동치를 만든 뒤 별도 PR 로 해야 한다.
 *
 * ── 캐시 금지 축 ─────────────────────────────────────────────────────────
 * degraded(부분 실패로 stale snapshot 이 섞인) 응답과 에러 응답은 절대
 * 캐시하지 않는다. 캐시하면 TTL 동안 열화 응답이 고정되어 다음 폴링의
 * 자가복구를 막는다 — 이는 route 내부 캐시가 `anyInningDegraded` 일 때
 * setCachedResponse 를 건너뛰는 기존 계약과 동일하다.
 */

/** `game-relay` 엣지 TTL. route 내부 CACHE_TTL_MS(2,000ms)와 동일해야 한다. */
export const RELAY_EDGE_TTL_SECONDS = 2;

/** 열화·에러 응답용. 엣지·브라우저 모두 캐시 금지. */
export const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
};

/**
 * 엣지(공유 캐시)만 캐시하고 브라우저는 캐시하지 않는 헤더.
 *
 * - `max-age=0`: 브라우저 로컬 캐시 금지. 클라이언트는 폴링 간격을 스스로
 *   통제해야 하므로 사설 캐시가 끼면 관측 불가능한 지연이 생긴다.
 * - `s-maxage=<ttl>`: 엣지 공유 캐시 TTL. 동시 요청은 여기서 흡수된다.
 * - `must-revalidate`: TTL 만료 후 낡은 응답 재사용 금지(SWR 없음).
 */
export function edgeCacheHeaders(ttlSeconds: number): Record<string, string> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    // 잘못된 TTL 로 무기한 캐시가 되는 사고를 막는다(fail-close).
    return { ...NO_STORE_HEADERS };
  }
  return {
    "Cache-Control": `public, max-age=0, s-maxage=${ttlSeconds}, must-revalidate`,
  };
}

/**
 * 응답 건전성에 따라 캐시 헤더를 고른다.
 *
 * @param cacheable 완전 정상 응답이면 true. degraded/부분실패/에러면 false.
 */
/**
 * route 내부 캐시 HIT 응답용 헤더.
 *
 * 이미 age 가 쌓인 snapshot 을 다시 full TTL 로 엣지에 올리면 age 가 직렬로
 * 누적된다(위 주석 참조). 남은 수명(ms)을 초 단위로 내림해 그만큼만 준다.
 * 남은 수명이 1초 미만이면 캐시 가치가 없고 반올림 오차로 상한을 넘길 수 있어
 * no-store 로 fail-close 한다.
 *
 * @param remainingMs 이 snapshot 이 route 캐시에서 살아 있을 남은 시간(ms)
 * @param ttlSeconds  이 route 의 엣지 TTL 상한
 */
export function edgeCacheHeadersForRemaining(
  remainingMs: number,
  ttlSeconds: number,
): Record<string, string> {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { ...NO_STORE_HEADERS };
  const remainingSeconds = Math.floor(remainingMs / 1000);
  if (remainingSeconds < 1) return { ...NO_STORE_HEADERS };
  return edgeCacheHeaders(Math.min(remainingSeconds, ttlSeconds));
}

export function liveCacheHeaders(
  cacheable: boolean,
  ttlSeconds: number,
): Record<string, string> {
  return cacheable ? edgeCacheHeaders(ttlSeconds) : { ...NO_STORE_HEADERS };
}
