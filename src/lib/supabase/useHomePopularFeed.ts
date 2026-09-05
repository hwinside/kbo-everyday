"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./client";
import { useBlockedIds } from "./useBlock";
import type { Post } from "./usePosts";
import { applyBoardFilter, FEED_SELECT, mapFeedRow, type FeedBoard } from "./useUnifiedFeed";
import { getTeamBySlug } from "@/lib/constants/teams";
import { resolvePostScope } from "@/lib/utils/post-scope";
import { scopeInputForPost } from "@/lib/utils/post-scope-input";

/** 인기글 집계 창(일). 하린아빠 스펙 2026-09-05: 최근 일주일 인기글. */
export const POPULAR_WINDOW_DAYS = 7;

/** 인기도 keyset 커서 — (popularity desc, id desc) 순서의 마지막 행. */
export type PopularCursor = { popularity: number; id: number };

/** 한 페이지 결과. rows = 화면에 붙일 글, fetched/last = 서버가 돌려준 행 수·마지막 행(커서·hasMore 판정). */
type PopularPage = { rows: Post[]; fetched: number; last: Post | null };

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

/**
 * 홈 '커뮤니티 인기글' 훅 — 최근 7일 글을 인기도(하트+댓글) 순으로, `initialSize` 개 먼저 보여주고
 * `loadMore()` 마다 `stepSize` 개씩 이어 붙인다(5 → 20 → 35 …). 창 안 글이 소진되면 hasMore=false.
 * 뒤로가기 복원·좋아요 상태는 홈 섹션이 쓰지 않으므로 useUnifiedFeed 대신 얇게 분리했다.
 */
export function useHomePopularFeed(board: FeedBoard, initialSize: number, stepSize: number) {
  const { blockedIds } = useBlockedIds();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const key = board.kind === "team" ? `team:${board.teamId}` : board.kind === "player" ? `player:${board.kboId}` : "all";
  // 최애팀 단독 판정용 팀 id(팀 보드일 때만). slug 가 정규 구단이 아니면 null → 클라이언트 재확인은 건너뛴다.
  const teamOnlyId = board.kind === "team" ? (getTeamBySlug(board.teamId)?.id ?? null) : null;
  const cursorRef = useRef<PopularCursor | null>(null);
  const fetchingRef = useRef(false);
  // 창 시작은 페이지 사이에서 고정 — 매 페이지 now() 를 다시 잡으면 경계 글이 빠지며 keyset 이 어긋난다.
  const windowStartRef = useRef<string>(popularWindowStart());

  const loadPage = useCallback(
    async (cursor: PopularCursor | null, size: number): Promise<PopularPage> => {
      // query-guard: bounded -- (popularity,id) keyset + .limit(size) + created_at 7일 창.
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
      const { data } = await query
        .order("popularity", { ascending: false })
        .order("id", { ascending: false })
        .limit(size);
      const all = (data ?? []).map((r) => mapFeedRow(r as Record<string, unknown>));
      // 커서·hasMore 는 서버가 돌려준 행 수(fetched) 기준 — 클라이언트 재확인으로 빠진 행이 있어도
      // keyset 이 앞으로 전진해야 같은 페이지를 다시 읽지 않는다.
      const rows = teamOnlyId == null ? all : all.filter((p) => isTeamOnlyPost(p, teamOnlyId));
      return { rows, fetched: all.length, last: all.length ? all[all.length - 1] : null };
    },
    // board 는 매 렌더 새 객체라 안정 키(key)로 대체(teamOnlyId 는 key 에서 파생).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const loadFirst = useCallback(async () => {
    windowStartRef.current = popularWindowStart();
    cursorRef.current = null;
    const page = await loadPage(null, initialSize);
    cursorRef.current = page.last ? cursorOf(page.last) : null;
    setHasMore(page.fetched === initialSize);
    return page.rows;
  }, [loadPage, initialSize]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPosts([]);
    (async () => {
      const rows = await loadFirst();
      if (cancelled) return;
      setPosts(rows);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || !hasMore || loading) return;
    fetchingRef.current = true;
    setLoadingMore(true);
    try {
      const page = await loadPage(cursorRef.current, stepSize);
      setPosts((prev) => {
        // 인기도는 실시간으로 바뀌므로 페이지 사이에 순위가 움직인 글이 재등장할 수 있다 → id 로 dedupe.
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.rows.filter((r) => !seen.has(r.id))];
      });
      if (page.last) cursorRef.current = cursorOf(page.last);
      setHasMore(page.fetched === stepSize);
    } finally {
      setLoadingMore(false);
      fetchingRef.current = false;
    }
  }, [hasMore, loading, loadPage, stepSize]);

  const reload = useCallback(async () => {
    setLoading(true);
    const rows = await loadFirst();
    setPosts(rows);
    setLoading(false);
  }, [loadFirst]);

  return {
    posts: blockedIds.size ? posts.filter((p) => !blockedIds.has(p.author_id)) : posts,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    reload,
  };
}
