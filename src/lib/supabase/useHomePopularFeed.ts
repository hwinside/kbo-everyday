"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./client";
import { useBlockedIds } from "./useBlock";
import type { Post } from "./usePosts";
import { applyBoardFilter, FEED_SELECT, mapFeedRow, type FeedBoard } from "./useUnifiedFeed";
import { getTeamBySlug } from "@/lib/constants/teams";
import { resolvePostScope } from "@/lib/utils/post-scope";
import { scopeInputForPost } from "@/lib/utils/post-scope-input";

/** 인기글 집계 창(일). 하린아빠 스펙 2026-09-05: 최근 일주일 인기글. */
export const POPULAR_WINDOW_DAYS = 7;

/**
 * 화면 글 수를 채우기 위해 한 번의 loadFirst/loadMore 안에서 서버를 읽는 최대 횟수.
 * 단독 공개·차단·중복 재확인으로 한 묶음이 통째로 탈락해도 뒤의 적합 글을 이어 읽되(삼순 #1343 ③),
 * 창 안 글이 전부 부적합인 극단에서 무한 조회하지 않도록 상한을 둔다. 상한에 걸리면 hasMore=true 로
 * 남겨 다음 '더 보기'가 이어 읽는다.
 */
export const MAX_FILL_BATCHES = 4;

/** 인기도 keyset 커서 — (popularity desc, id desc) 순서의 마지막으로 소비한 행. */
export type PopularCursor = { popularity: number; id: number };

/** 집계 창 시작 시각(ISO). 페이지 간 창이 흔들리지 않도록 마운트 시 1회 고정해 쓴다. */
export function popularWindowStart(now: number = Date.now()): string {
  return new Date(now - POPULAR_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * (popularity desc, id desc) keyset 의 "커서 다음" 조건을 PostgREST `or=` 문자열로.
 *   popularity < c.popularity  OR  (popularity = c.popularity AND id < c.id)
 * 보드 필터도 `.or()` 를 쓰지만 PostgREST 는 `or=` 파라미터 여러 개를 AND 로 묶으므로 충돌 없음.
 */
export function popularCursorFilter(c: PopularCursor): string {
  return `popularity.lt.${c.popularity},and(popularity.eq.${c.popularity},id.lt.${c.id})`;
}

/**
 * 최애팀 **단독** 공개 글의 team_tags 값 — PostgREST jsonb `eq` 비교용 (`team_tags=eq.["lg"]`).
 *
 * 하린아빠 스펙 2026-09-05: "공개범위가 최애팀까지 포함인 건 제외하고 only 최애팀인 것만".
 * 팀 피드의 `cs`(포함) 필터는 전체구단 공개(10팀)·다팀 글까지 잡으므로 홈 인기글엔 쓰지 않는다.
 * 실측(prod 9/5, LG 7일): cs 294건 = 10팀 261 + 2~9팀 17 + LG 단독 16.
 * 레거시 무태그 글은 고려하지 않는다 — 2026-08-07 DB 트리거 이후 모든 글이 canonical 태그 1개 이상이라
 * 7일 창 안에는 존재할 수 없다.
 */
export function teamOnlyTagsValue(slug: string): string {
  return JSON.stringify([slug]);
}

/**
 * 화면 라벨 SSOT(resolvePostScope)로 "최애팀 단독" 을 재확인한다.
 * team_tags 는 [최애팀] 이어도 다른 팀 선수 태그가 섞이면 배지는 2팀으로 뜬다 — 서버 eq 필터가
 * 놓치는 그 경우를 여기서 걸러 "홈 인기글 = 최애팀 단독 배지" 를 보장한다.
 */
export function isTeamOnlyPost(post: Post, teamId: number): boolean {
  const scope = resolvePostScope(scopeInputForPost(post));
  return (scope.kind === "team" || scope.kind === "player") && scope.teamId === teamId;
}

/** 행 → 커서. 생성 컬럼이 select 에 없거나 null 이면(마이그레이션 전) 카운터 합으로 대체. */
export function cursorOf(post: Post): PopularCursor {
  const popularity = post.popularity ?? (post.like_count ?? 0) + (post.comment_count ?? 0);
  return { popularity, id: post.id };
}

/** 서버 한 묶음 읽기 — 커서 다음부터 `limit` 행. 실패는 throw(호출자가 오류/소진을 구분한다). */
export type FetchBatch = (cursor: PopularCursor | null, limit: number) => Promise<Post[]>;

/** 한 번의 채우기 결과. `exhausted` = 창 안에 다음 적합 글이 더 없음이 서버 응답으로 확인됨. */
export type FillResult = { rows: Post[]; cursor: PopularCursor | null; exhausted: boolean };

/**
 * 화면에 실제로 보일 글을 `want` 개 채운다(삼순 #1343 ②③ — 순수 함수로 분리해 게이트가 직접 실행).
 *
 * - 서버는 `want + 1` 행을 읽어 마지막 1행을 "다음 글 존재" 확인용으로 쓴다. 정확히 5·20·35건이면
 *   확인 행이 비어 그 자리에서 exhausted=true → 버튼이 즉시 숨는다.
 * - `isVisible` 을 통과하고 `seen` 에 없는 행만 담는다. 한 묶음이 전부 탈락해도 마지막 행 커서로
 *   이어 읽어 `want` 를 채운다(최대 MAX_FILL_BATCHES 회).
 * - 커서는 항상 **마지막으로 소비한 행**(want 를 채운 행)이다. 그 뒤에 남은 행은 다음 호출이 다시 읽는다.
 * - 조회 오류는 그대로 throw — 호출자가 커서/hasMore 를 보존해 재시도 가능하게 한다.
 */
export async function fillVisible(
  fetchBatch: FetchBatch,
  start: PopularCursor | null,
  want: number,
  isVisible: (post: Post) => boolean,
  seen: ReadonlySet<number>,
  maxBatches: number = MAX_FILL_BATCHES,
): Promise<FillResult> {
  const rows: Post[] = [];
  const picked = new Set<number>();
  let cursor = start;
  for (let batch = 0; batch < maxBatches; batch++) {
    const need = want - rows.length;
    const fetched = await fetchBatch(cursor, need + 1);
    const hasBeyond = fetched.length > need;
    const page = hasBeyond ? fetched.slice(0, need) : fetched;
    let consumedTo = page.length ? page.length - 1 : -1;
    for (let i = 0; i < page.length; i++) {
      const p = page[i];
      if (seen.has(p.id) || picked.has(p.id) || !isVisible(p)) continue;
      picked.add(p.id);
      rows.push(p);
      if (rows.length === want) {
        consumedTo = i;
        break;
      }
    }
    if (consumedTo >= 0) cursor = cursorOf(page[consumedTo]);
    if (rows.length === want) {
      // 채웠다. 소비한 행 뒤에 남은 행(같은 묶음의 나머지 또는 확인 행)이 있으면 다음 글이 있다.
      const leftover = consumedTo < page.length - 1 || hasBeyond;
      return { rows, cursor, exhausted: !leftover };
    }
    if (!hasBeyond) return { rows, cursor, exhausted: true };
    // 묶음을 다 봤는데 아직 모자라고 뒤에 더 있다 → 확인 행부터 이어 읽는다(확인 행은 아직 안 봤으므로
    // 커서는 소비한 마지막 행 = page 의 끝).
    cursor = cursorOf(page[page.length - 1]);
  }
  // 상한 도달 — 못 채웠지만 소진은 아니다(다음 '더 보기'가 이어 읽는다).
  return { rows, cursor, exhausted: false };
}

/**
 * 홈 '커뮤니티 인기글' 훅 — 최근 7일 글을 인기도(하트+댓글) 순으로, `initialSize` 개 먼저 보여주고
 * `loadMore()` 마다 `stepSize` 개씩 이어 붙인다(5 → 20 → 35 …). 창 안 글이 소진되면 hasMore=false.
 * 뒤로가기 복원·좋아요 상태는 홈 섹션이 쓰지 않으므로 useUnifiedFeed 대신 얇게 분리했다.
 */
export function useHomePopularFeed(board: FeedBoard, initialSize: number, stepSize: number) {
  const { blockedIds } = useBlockedIds();
  return useHomePopularFeedCore(board, initialSize, stepSize, blockedIds);
}

/**
 * 차단 목록을 주입받는 코어(회귀 게이트가 AuthProvider 없이 직접 마운트한다).
 *
 * 삼순 #1343 재리뷰 반영:
 *  ① 응답 세대(genRef) — 팀 전환·새로고침·pull-to-refresh 마다 세대를 올리고, 늦게 도착한 옛 응답은
 *     posts/cursor/hasMore/loading 어느 것도 갱신하지 못한다(초기 조회·더보기·reload 모두).
 *  ② 오류·소진 분리 — 조회 실패는 cursor/hasMore 를 보존해 재시도 가능하게 두고, 소진은 서버가
 *     "다음 글 없음" 을 돌려줬을 때만(fillVisible 확인 행) 확정한다.
 *  ③ 화면 글 수 채우기 — 단독 공개·차단·중복 재확인 후 실제 보이는 글이 5/15개가 되도록 fillVisible 이
 *     이어 읽는다. 차단 목록이 늦게 도착해 첫 묶음이 뒤늦게 탈락하는 경우도 첫 페이지를 다시 채운다.
 */
export function useHomePopularFeedCore(
  board: FeedBoard,
  initialSize: number,
  stepSize: number,
  blockedIds: ReadonlySet<string>,
) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const key = board.kind === "team" ? `team:${board.teamId}` : board.kind === "player" ? `player:${board.kboId}` : "all";
  // 최애팀 단독 판정용 팀 id(팀 보드일 때만). slug 가 정규 구단이 아니면 null → 클라이언트 재확인은 건너뛴다.
  const teamOnlyId = board.kind === "team" ? (getTeamBySlug(board.teamId)?.id ?? null) : null;
  // 차단 목록은 Set 참조가 매 refresh 바뀌므로 내용 서명으로 안정화 — 내용이 바뀔 때만 첫 페이지를 다시 채운다.
  const blockedSig = useMemo(() => Array.from(blockedIds).sort().join(","), [blockedIds]);
  const blockedRef = useRef(blockedIds);
  blockedRef.current = blockedIds;

  const cursorRef = useRef<PopularCursor | null>(null);
  const fetchingRef = useRef(false);
  // 응답 세대. loadFirst/reload 마다 +1. 요청이 시작될 때의 세대와 다르면 그 응답은 버린다.
  const genRef = useRef(0);
  // 창 시작은 페이지 사이에서 고정 — 매 페이지 now() 를 다시 잡으면 경계 글이 빠지며 keyset 이 어긋난다.
  const windowStartRef = useRef<string>(popularWindowStart());

  const fetchBatch = useCallback<FetchBatch>(
    async (cursor, limit) => {
      // query-guard: bounded -- (popularity,id) keyset + .limit(limit) + created_at 7일 창.
      let query = supabase
        .from("posts")
        // popularity 는 홈 인기글만 쓰는 생성 컬럼 — 공통 FEED_SELECT 에 넣으면 마이그레이션 전 preview 에서
        // 커뮤니티 피드 전체가 400 으로 죽는다. 이 훅에서만 추가 select 한다.
        .select(`${FEED_SELECT}, popularity`)
        .neq("is_hidden", true)
        .gte("created_at", windowStartRef.current);
      // 팀 보드 = 최애팀 **단독** 공개 글만(team_tags 가 정확히 [최애팀]). 팀 피드의 포함(cs) 필터인
      // applyBoardFilter 는 전체구단 공개·다팀 글까지 잡아 스펙과 어긋난다 — 최애팀 미선택(all)일 때만 공용 필터.
      query = board.kind === "team" ? query.filter("team_tags", "eq", teamOnlyTagsValue(board.teamId)) : applyBoardFilter(query, board);
      if (cursor) query = query.or(popularCursorFilter(cursor));
      const { data, error } = await query
        .order("popularity", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      // 조회 오류는 소진이 아니다 — throw 해서 호출자가 커서/hasMore 를 보존하게 한다(삼순 #1343 ②).
      if (error) throw error;
      return (data ?? []).map((r) => mapFeedRow(r as Record<string, unknown>));
    },
    // board 는 매 렌더 새 객체라 안정 키(key)로 대체(teamOnlyId 는 key 에서 파생).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  // 화면 노출 판정 = 최애팀 단독(배지 SSOT) AND 비차단. 차단 목록은 ref 로 읽어 채우기 도중 최신값을 쓴다.
  const isVisible = useCallback(
    (p: Post) => !blockedRef.current.has(p.author_id) && (teamOnlyId == null || isTeamOnlyPost(p, teamOnlyId)),
    [teamOnlyId],
  );

  /** 첫 페이지. 세대를 올려 진행 중이던 초기 조회·더보기 응답을 전부 무효화한다. */
  const loadFirst = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    windowStartRef.current = popularWindowStart();
    let result: FillResult;
    try {
      result = await fillVisible(fetchBatch, null, initialSize, isVisible, new Set());
    } catch {
      if (gen !== genRef.current) return;
      // 첫 조회 실패: 섹션은 비우되 hasMore 는 남겨 pull-to-refresh(reload)가 다시 시도할 수 있게 한다.
      cursorRef.current = null;
      setPosts([]);
      setLoading(false);
      return;
    }
    if (gen !== genRef.current) return; // 옛 세대 응답 폐기(삼순 #1343 ①)
    cursorRef.current = result.cursor;
    setPosts(result.rows);
    setHasMore(!result.exhausted);
    setLoading(false);
  }, [fetchBatch, initialSize, isVisible]);

  // blockedSig: 차단 목록 내용이 바뀌면(로그인 직후 늦게 도착 포함) 첫 페이지를 다시 채운다(삼순 #1343 ③).
  useEffect(() => {
    const gen = genRef;
    void loadFirst();
    return () => {
      // 언마운트·키 교체 시 진행 중 응답 무효화.
      gen.current++;
    };
  }, [loadFirst, blockedSig]);

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || !hasMore || loading) return;
    const gen = genRef.current;
    fetchingRef.current = true;
    setLoadingMore(true);
    try {
      // 인기도는 실시간으로 바뀌므로 페이지 사이에 순위가 움직인 글이 재등장할 수 있다 → 화면의 id 로 dedupe.
      const seen = new Set(posts.map((p) => p.id));
      const result = await fillVisible(fetchBatch, cursorRef.current, stepSize, isVisible, seen);
      if (gen !== genRef.current) return; // 팀 전환·새로고침이 끼어들었다 → 옛 더보기 응답 폐기(삼순 #1343 ①)
      cursorRef.current = result.cursor;
      setPosts((prev) => [...prev, ...result.rows]);
      setHasMore(!result.exhausted);
    } catch {
      // 조회 실패: cursor/hasMore 그대로 → 버튼이 남아 재시도할 수 있다(삼순 #1343 ②).
    } finally {
      fetchingRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, loading, posts, fetchBatch, stepSize, isVisible]);

  return {
    posts,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    reload: loadFirst,
  };
}
