import { NextResponse } from "next/server";

/**
 * degraded 신호 헤더 SSOT — game-relay(producer)와 relay 퍼블리셔(consumer)가
 * 같은 상수를 import 한다(문자열 복제 금지 → 오타 mutation 축을 원리적으로 제거).
 *
 * game-relay 는 일부 이닝 fetch 실패 시 last-good 을 섞은 degraded 200 을 반환한다.
 * frames-stale(stale-equal) 판정은 "완전 fresh 200 + 내용 동일"만 증거로 세야 하므로
 * (삼순 #1331 NO-GO ①), producer 가 이 헤더로 fresh/degraded 를 명시한다.
 * body 에 넣지 않는 이유: 값 토글이 frameHash 를 바꿔 무변경 tick 재발행을 유발한다.
 */
export const RELAY_DEGRADED_HEADER = "x-kbo-relay-degraded";

/**
 * game-relay fresh-miss 경로의 JSON 응답 빌더(producer seam). 헤더 부착 로직이
 * 이 함수 하나에 있으므로, 게이트가 **이 함수를 실행**해 degraded/fresh 양방향을
 * 검증하면 헤더 삭제·오타 mutation 이 실행으로 RED 가 된다(구조판정 의존 최소화).
 */
export function buildRelayJsonResponse(
  body: unknown,
  cacheHeaders: Record<string, string>,
  anyInningDegraded: boolean,
): NextResponse {
  return NextResponse.json(body, {
    headers: {
      ...cacheHeaders,
      ...(anyInningDegraded ? { [RELAY_DEGRADED_HEADER]: "1" } : {}),
    },
  });
}
