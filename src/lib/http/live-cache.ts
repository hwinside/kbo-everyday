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
 * 쓰고 있는 CACHE_TTL_MS(2,000ms) 와 **같은 값**이다. 즉 엣지 캐시를 켜도
 * 유저가 볼 수 있는 최대 지연 상한은 지금과 동일하고, 달라지는 것은 그
 * 2초 창을 여러 lambda 인스턴스가 각자 감당하느냐(현행) 엣지가 한 번만
 * 감당하느냐(변경 후)뿐이다.
 *
 * ── 캐시 금지 축 ─────────────────────────────────────────────────────────
 * degraded(부분 실패로 stale snapshot 이 섞인) 응답과 에러 응답은 절대
 * 캐시하지 않는다. 캐시하면 TTL 동안 열화 응답이 고정되어 다음 폴링의
 * 자가복구를 막는다 — 이는 route 내부 캐시가 `anyInningDegraded` 일 때
 * setCachedResponse 를 건너뛰는 기존 계약과 동일하다.
 */

/** `game-relay` 엣지 TTL. route 내부 CACHE_TTL_MS(2,000ms)와 동일해야 한다. */
export const RELAY_EDGE_TTL_SECONDS = 2;

/** 경기 목록/맥락 통계처럼 relay 보다 느리게 바뀌는 라이브 API TTL. */
export const LIVE_LIST_EDGE_TTL_SECONDS = 5;

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
export function liveCacheHeaders(
  cacheable: boolean,
  ttlSeconds: number,
): Record<string, string> {
  return cacheable ? edgeCacheHeaders(ttlSeconds) : { ...NO_STORE_HEADERS };
}
