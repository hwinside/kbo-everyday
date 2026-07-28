/**
 * game-relay delta(증분) 폴링 순수 헬퍼.
 *
 * 배경: 라이브 문자중계는 폴링(2~3초)마다 1회부터 현재까지 전 이닝의 play-by-play를
 * 통째로 재전송한다. 끝난 이닝은 불변("past innings never vanish")이라 매번 재전송하면
 * origin transfer만 낭비된다(경기 후반=관중 최다 시점에 payload 폭증). 클라이언트가 이미
 * 보유한 지난 이닝은 생략하고 현재/직전 이닝만 내려보내면 실시간 손실 0으로 비용만 깎인다.
 *
 * 서버는 filterDeltaInnings 로 부분 집합을 만들고, 클라이언트는 mergeDeltaInnings 로
 * 기존 보유 이닝 위에 병합한다. matchup/playerStats/linescore/currentInning 등 라이브
 * 필드는 delta 여부와 무관하게 항상 최신값을 그대로 유지한다(이 헬퍼는 innings만 다룬다).
 */
import type { InningRelay } from "@/app/api/game-relay/route";

/** 이닝 병합 키: 같은 이닝의 초/말을 구분한다. */
export function inningKey(inn: InningRelay): string {
  return `${inn.inning}-${inn.half}`;
}

/**
 * 서버 delta 필터. since(클라가 보유한 최대 이닝 번호) 이상만 남기되, 직전 이닝(since-1)도
 * 포함해 방금 끝난 이닝에 지연 반영되는 play 를 놓치지 않는다. since<=0 이면 전체(full).
 */
export function filterDeltaInnings(innings: InningRelay[], since: number): InningRelay[] {
  if (!Number.isFinite(since) || since <= 0) return innings;
  const minInning = Math.max(1, Math.floor(since) - 1);
  return innings.filter((inn) => inn.inning >= minInning);
}

/**
 * full 응답에서 delta(부분) 응답을 파생하는 단일 계약. since<=0 이면 full 그대로 반환하고,
 * since>0 이면 innings 를 filterDeltaInnings 로 줄이고 partial:true 를 세운다.
 *
 * fresh(업스트림) 경로와 warm responseCache HIT 경로가 **반드시 같은 delta 의미**를 갖도록
 * 두 경로 모두 이 함수를 통과시킨다(삼순 blocker ①: cache-hit 이 since 를 무시하고 full 을
 * 재전송하던 회귀 차단). 입력 객체는 변형하지 않는다(캐시 오염 방지, 얕은 복사).
 */
export function toDeltaResponse<T extends { innings: InningRelay[]; partial?: boolean }>(
  full: T,
  since: number,
): T {
  if (!Number.isFinite(since) || since <= 0) return full;
  return { ...full, innings: filterDeltaInnings(full.innings, since), partial: true };
}

/**
 * 클라이언트 병합. partial(delta) 응답이면 cache 위에 응답 이닝을 키별로 덮어쓰고 나머지
 * 과거 이닝은 유지한다. full 응답이면 cache 를 응답 이닝으로 재구성한다(과거 이닝 정정 반영).
 * cache 는 호출자가 소유하는 Map 으로, 이 함수가 in-place 로 갱신하고 병합된 배열을 반환한다.
 */
export function mergeDeltaInnings(
  cache: Map<string, InningRelay>,
  responseInnings: InningRelay[],
  partial: boolean,
): InningRelay[] {
  if (!partial) cache.clear();
  for (const inn of responseInnings) cache.set(inningKey(inn), inn);
  return Array.from(cache.values());
}
