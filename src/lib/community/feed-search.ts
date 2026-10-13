/**
 * 커뮤니티 검색 v1 — 순수 함수(회귀 검증 대상). 브라우저·Supabase 의존성 없음(feed-restore.ts 와 같은 이유:
 * 스모크가 `useUnifiedFeed` 를 import 하면 supabase 클라이언트가 env 없이 모듈 로드 시점에 throw 한다).
 */

/**
 * 검색어 최소 길이 — **UX 게이트 전용**(이 길이 미만이면 요청을 보내지 않고 일반 피드를 보인다).
 * 결과를 바꾸는 길이 검증·LIKE 이스케이프의 유일한 지점은 DB 함수 `search_posts` 다(삼순 리뷰 ①).
 * 여기 값은 그 함수의 하한(2)과 같거나 커야 한다 — 작으면 "결과 없음"만 보게 되고, 크면 그만큼 요청을 아낀다.
 * 성능 게이트(qa:community-search:perf)에서 2자가 기준을 넘으면 3 으로 올리는 것이 UX 결정 안건.
 */
export const SEARCH_MIN_LEN = 2;

/**
 * 검색어 정규화. trim 만 하고 이스케이프는 하지 않는다(RPC 단일 지점).
 * 길이가 SEARCH_MIN_LEN 미만이면 null = "검색 아님"(일반 피드).
 */
export function normalizeSearchQuery(raw: string | null | undefined): string | null {
  const q = (raw ?? "").trim();
  return q.length >= SEARCH_MIN_LEN ? q : null;
}

/** 피드가 바라보는 보드 컨텍스트. 전체글/팀/선수가 같은 훅을 source만 바꿔 재사용. `all.q` = 전체글 검색어. */
export type FeedBoard =
  | { kind: "all"; q?: string | null }
  | { kind: "team"; teamId: string }
  | { kind: "player"; kboId: string };

/**
 * 피드 식별 키. 커서·초기 로드 취소·뒤로가기 복원 저장(sessionStorage)이 모두 이 키를 쓴다.
 * 검색어가 있으면 키에 포함 → 검색어별로 커서 리셋·복원 상태가 분리된다(삼순 리뷰 ④).
 * 검색어 없는 전체글은 기존 "all" 그대로 — 이미 저장돼 있는 복원 상태와 호환.
 */
export function feedKeyFor(board: FeedBoard): string {
  switch (board.kind) {
    case "team":
      return `team:${board.teamId}`;
    case "player":
      return `player:${board.kboId}`;
    case "all": {
      const q = normalizeSearchQuery(board.q);
      return q === null ? "all" : `all:q=${q}`;
    }
  }
}
