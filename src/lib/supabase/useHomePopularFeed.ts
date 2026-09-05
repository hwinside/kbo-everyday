"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./client";
import { useBlockedIds } from "./useBlock";
import type { Post } from "./usePosts";
import { applyBoardFilter, FEED_SELECT, mapFeedRow, type FeedBoard } from "./useUnifiedFeed";

/** 인기글 집계 창(일). 하린아빠 스펙 2026-09-05: 최근 일주일 인기글. */
export const POPULAR_WINDOW_DAYS = 7;

/** 인기도 keyset 커서 — (popularity desc, id desc) 순서의 마지막 행. */
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
  const cursorRef = useRef<PopularCursor | null>(null);
  const fetchingRef = useRef(false);
  // 창 시작은 페이지 사이에서 고정 — 매 페이지 now() 를 다시 잡으면 경계 글이 빠지며 keyset 이 어긋난다.
  const windowStartRef = useRef<string>(popularWindowStart());

  const loadPage = useCallback(
    async (cursor: PopularCursor | null, size: number): Promise<Post[]> => {
      // query-guard: bounded -- (popularity,id) keyset + .limit(size) + created_at 7일 창.
      let query = supabase
        .from("posts")
        // popularity 는 홈 인기글만 쓰는 생성 컬럼 — 공통 FEED_SELECT 에 넣으면 마이그레이션 전 preview 에서
        // 커뮤니티 피드 전체가 400 으로 죽는다. 이 훅에서만 추가 select 한다.
        .select(`${FEED_SELECT}, popularity`)
        .neq("is_hidden", true)
        .gte("created_at", windowStartRef.current);
      query = applyBoardFilter(query, board);
      if (cursor) query = query.or(popularCursorFilter(cursor));
      const { data } = await query
        .order("popularity", { ascending: false })
        .order("id", { ascending: false })
        .limit(size);
      return (data ?? []).map((r) => mapFeedRow(r as Record<string, unknown>));
    },
    // board 는 매 렌더 새 객체라 안정 키(key)로 대체.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const loadFirst = useCallback(async () => {
    windowStartRef.current = popularWindowStart();
    cursorRef.current = null;
    const rows = await loadPage(null, initialSize);
    cursorRef.current = rows.length ? cursorOf(rows[rows.length - 1]) : null;
    setHasMore(rows.length === initialSize);
    return rows;
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
      const rows = await loadPage(cursorRef.current, stepSize);
      setPosts((prev) => {
        // 인기도는 실시간으로 바뀌므로 페이지 사이에 순위가 움직인 글이 재등장할 수 있다 → id 로 dedupe.
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...rows.filter((r) => !seen.has(r.id))];
      });
      if (rows.length) cursorRef.current = cursorOf(rows[rows.length - 1]);
      setHasMore(rows.length === stepSize);
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
