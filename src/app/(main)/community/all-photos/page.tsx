"use client";

import { useEffect, useMemo, useState } from "react";
import PhotoFeed from "@/components/community/PhotoFeed";
import { supabase } from "@/lib/supabase/client";
import { toggleLike, type Post } from "@/lib/supabase/usePosts";
import { getPostSourceLabel } from "@/lib/utils/community-board";

type SortTab = "latest" | "hot";

export default function AllPhotosPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortTab, setSortTab] = useState<SortTab>("latest");
  // hot 필터의 "최근 30일" 기준 시각 — useMemo 안에서 Date.now() 직접 호출은
  // react-hooks/purity 룰 위반이라 useState lazy init으로 mount 시 한 번만 잡아둔다.
  // (30일 정밀도라 페이지 오래 열어둬도 무관.)
  const [nowMs] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      // query-guard: bounded -- 전체 사진 피드는 최신 100개만 제공하는 의도된 단일 UI 페이지다.
      const { data } = await supabase
        .from("posts")
        .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, team_tags, hashtags, author_team_id_snapshot, click_view_count, impression_view_count, profiles(nickname, team_id, grade, points, avatar_url)")
        .in("board_type", ["team", "player"])
        .eq("content_type", "photo")
        .neq("is_hidden", true)
        .order("created_at", { ascending: false })
        .limit(100);

      if (cancelled) return;

      setPosts((data ?? []).map((p) => {
        const profileRaw = Array.isArray(p.profiles) ? p.profiles[0] : p.profiles;
        const profile = (profileRaw ?? null) as unknown as Record<string, unknown> | null;
        const snap = (p as Record<string, unknown>).author_team_id_snapshot as number | null | undefined;
        return {
          ...p,
          content_type: (p.content_type ?? "photo") as "general" | "photo",
          image_urls: (p.image_urls ?? []) as string[],
          video_urls: ((p as Record<string, unknown>).video_urls ?? []) as string[],
          nickname: profile?.nickname as string | undefined,
          team_id: (snap ?? (profile?.team_id as number | undefined)) as number | undefined,
          avatar_url: profile?.avatar_url as string | undefined,
          grade: profile?.grade as string | undefined,
          points: (profile?.points as number) ?? 0,
          click_view_count: ((p as Record<string, unknown>).click_view_count as number | null | undefined) ?? 0,
          impression_view_count: ((p as Record<string, unknown>).impression_view_count as number | null | undefined) ?? 0,
        };
      }));
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const sortedPosts = useMemo(() => {
    if (sortTab === "latest") return posts;
    return [...posts]
      .filter((p) => nowMs - new Date(p.created_at).getTime() < 30 * 24 * 60 * 60 * 1000)
      .sort((a, b) => b.like_count - a.like_count || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [posts, sortTab, nowMs]);

  const sourceLabels = useMemo(
    () => Object.fromEntries(sortedPosts.map((post) => [post.id, getPostSourceLabel(post)])),
    [sortedPosts],
  );

  const handleLike = async (postId: number) => {
    try {
      await toggleLike(postId);
    } catch {
      // ignore if not logged in
    }
  };

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="px-5 pt-4 pb-2">
        <p className="text-sm text-text-tertiary">팀과 선수 사진글을 서비스 전체 기준으로 모아봅니다.</p>
      </div>

      <div className="px-5 pb-2">
        <div className="flex gap-2">
          {(["latest", "hot"] as const).map((sort) => (
            <button
              key={sort}
              onClick={() => setSortTab(sort)}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
                sortTab === sort ? "bg-bg-tertiary text-text-primary" : "text-text-tertiary hover:text-text-secondary"
              }`}
            >
              {sort === "latest" ? "최신" : "인기"}
            </button>
          ))}
          {sortTab === "hot" && <span className="flex items-center text-xs text-text-tertiary ml-1">최근 30일</span>}
        </div>
      </div>

      <PhotoFeed posts={sortedPosts} loading={loading} onLike={handleLike} sourceLabels={sourceLabels} />
    </div>
  );
}
