"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { useBlockedIds } from "./useBlock";
import type { Post } from "./usePosts";
import { kboIdsForTeamSlug } from "@/lib/utils/player-roster";

/** 피드가 바라보는 보드 컨텍스트. 전체글/팀/선수가 같은 훅을 source만 바꿔 재사용. */
export type FeedBoard =
  | { kind: "all" }
  | { kind: "team"; teamId: string }
  | { kind: "player"; kboId: string };

const SELECT =
  "id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, team_tags, hashtags, author_team_id_snapshot, profiles(nickname, team_id, grade, points)";

function mapRow(p: Record<string, unknown>): Post {
  const prof = p.profiles as Record<string, unknown> | null;
  const snap = p.author_team_id_snapshot as number | null | undefined;
  return {
    ...(p as unknown as Post),
    content_type: ((p.content_type as string) ?? "general") as "general" | "photo",
    image_urls: (p.image_urls ?? []) as string[],
    video_urls: (p.video_urls ?? []) as string[],
    nickname: prof?.nickname as string | undefined,
    team_id: (snap ?? (prof?.team_id as number | undefined)) as number | undefined,
    grade: prof?.grade as string | undefined,
    points: (prof?.points as number) ?? 0,
  };
}

function boardKey(board: FeedBoard): string {
  switch (board.kind) {
    case "team":
      return `team:${board.teamId}`;
    case "player":
      return `player:${board.kboId}`;
    case "all":
      return "all";
  }
}

/**
 * 통합 커뮤니티 피드 훅.
 * - content_type 필터 없음 → 글/사진 한 스트림.
 * - 글로벌 serial `id` 기반 keyset 페이징(= created_at 내림차순과 동일 순서).
 * - 보이는 글들의 내 좋아요 상태를 페이지마다 배치 조회해 누적.
 */
export function useUnifiedFeed(board: FeedBoard, pageSize = 20) {
  const { user } = useAuth();
  const { blockedIds } = useBlockedIds();
  const [posts, setPosts] = useState<Post[]>([]);
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const key = boardKey(board);
  const cursorRef = useRef<number | null>(null);
  // 동시 페이지 요청 가드 (스크롤 연타 race 방지).
  const fetchingRef = useRef(false);

  const fetchLikedFor = useCallback(
    async (ids: number[]) => {
      if (!user || ids.length === 0) return;
      const { data } = await supabase
        .from("likes")
        .select("post_id")
        .eq("user_id", user.id)
        .in("post_id", ids);
      if (data) {
        setLikedIds((prev) => {
          const next = new Set(prev);
          data.forEach((r: { post_id: number }) => next.add(r.post_id));
          return next;
        });
      }
    },
    [user],
  );

  const loadPage = useCallback(
    async (cursor: number | null): Promise<Post[]> => {
      let query = supabase.from("posts").select(SELECT).neq("is_hidden", true);
      // 태그 기반 조회(V3): 팀탭 = "LG가 태그되거나 LG선수가 태그된 모든 글".
      // team_tags 만 보면 레거시·움짤콜렉터 글(board_type='player'/'team' + board_id, team_tags 빈 값)이
      // 누락되므로 3가지를 OR 로 묶는다:
      //   ① team_tags 에 팀 슬러그 포함 (신규 태그 글)             — jsonb cs.["lg"]
      //   ② 레거시 팀보드 글 (board_type='team' AND board_id=slug)
      //   ③ 레거시/움짤콜렉터 선수보드 글 (board_type='player' AND board_id ∈ 해당 팀 선수 kboId)
      // team_tags 는 JSONB → `cs.["lg"]`(JSON) 형태로 전달(배열 리터럴 `cs.{lg}`는 @> 파싱 에러).
      if (board.kind === "team") {
        const slug = board.teamId;
        const kboIds = kboIdsForTeamSlug(slug);
        const orParts = [
          `team_tags.cs.${JSON.stringify([slug])}`,
          `and(board_type.eq.team,board_id.eq.${slug})`,
        ];
        if (kboIds.length) {
          orParts.push(`and(board_type.eq.player,board_id.in.(${kboIds.map((id) => `"${id}"`).join(",")}))`);
        }
        query = query.or(orParts.join(","));
      } else if (board.kind === "player") query = query.eq("board_type", "player").eq("board_id", board.kboId);
      else query = query.in("board_type", ["team", "player", "free"]);
      if (cursor !== null) query = query.lt("id", cursor);
      // keyset = id desc 단일 컬럼. id가 BIGSERIAL(삽입=created_at 순 단조증가)이라
      // (created_at,id) 복합 keyset과 동일 순서이면서 tie-break 불필요 → 더 단순·견고. (의도적 선택)
      const { data } = await query.order("id", { ascending: false }).limit(pageSize);
      const rows = (data ?? []).map((r) => mapRow(r as Record<string, unknown>));
      return rows;
    },
    // board는 매 렌더 새 객체라 안정 키(key)로 대체. key가 바뀌면 loadPage 재생성.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, pageSize],
  );

  // 초기 로드 / 보드 전환.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPosts([]);
    setLikedIds(new Set());
    cursorRef.current = null;
    setHasMore(true);

    (async () => {
      const rows = await loadPage(null);
      if (cancelled) return;
      setPosts(rows);
      cursorRef.current = rows.length ? rows[rows.length - 1].id : null;
      setHasMore(rows.length === pageSize);
      setLoading(false);
      fetchLikedFor(rows.map((r) => r.id));
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pageSize, user?.id]);

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || !hasMore || loading) return;
    fetchingRef.current = true;
    setLoadingMore(true);
    try {
      const rows = await loadPage(cursorRef.current);
      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...rows.filter((r) => !seen.has(r.id))];
      });
      if (rows.length) cursorRef.current = rows[rows.length - 1].id;
      setHasMore(rows.length === pageSize);
      fetchLikedFor(rows.map((r) => r.id));
    } finally {
      setLoadingMore(false);
      fetchingRef.current = false;
    }
  }, [hasMore, loading, loadPage, pageSize, fetchLikedFor]);

  const reload = useCallback(async () => {
    setLoading(true);
    cursorRef.current = null;
    const rows = await loadPage(null);
    setPosts(rows);
    cursorRef.current = rows.length ? rows[rows.length - 1].id : null;
    setHasMore(rows.length === pageSize);
    setLikedIds(new Set());
    setLoading(false);
    fetchLikedFor(rows.map((r) => r.id));
  }, [loadPage, pageSize, fetchLikedFor]);

  /** 좋아요 optimistic 토글 — likedIds Set + 해당 post like_count 즉시 반영. */
  const setPostLiked = useCallback((postId: number, liked: boolean) => {
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (liked) next.add(postId);
      else next.delete(postId);
      return next;
    });
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? { ...p, like_count: Math.max(0, p.like_count + (liked ? 1 : -1)) }
          : p,
      ),
    );
  }, []);

  return {
    // 차단한 유저의 글은 피드에서 즉시 제외(차단 시 useBlockedIds가 브로드캐스트로 갱신 → 재렌더로 사라짐).
    posts: blockedIds.size ? posts.filter((p) => !blockedIds.has(p.author_id)) : posts,
    likedIds,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    reload,
    setPostLiked,
  };
}
