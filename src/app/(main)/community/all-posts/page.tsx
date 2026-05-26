"use client";

import { useEffect, useMemo, useState } from "react";
import PostList from "@/components/community/PostList";
import type { Post } from "@/lib/types";
import { supabase } from "@/lib/supabase/client";
import { getCommunitySourceLabel } from "@/lib/utils/community-board";

type SortTab = "latest" | "hot";

export default function AllPostsPage() {
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
      const { data } = await supabase
        .from("posts")
        .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, author_team_id_snapshot, profiles(nickname, team_id, grade, points)")
        .in("board_type", ["team", "player", "free"])
        .eq("content_type", "general")
        .neq("is_hidden", true)
        .order("created_at", { ascending: false })
        .limit(100);

      if (cancelled) return;

      setPosts((data ?? []).map((p) => {
        const profileRaw = Array.isArray(p.profiles) ? p.profiles[0] : p.profiles;
        const profile = (profileRaw ?? null) as unknown as Record<string, unknown> | null;
        return {
          id: p.id,
          boardType: p.board_type as "team" | "player" | "free",
          boardId: p.board_id,
          authorId: p.author_id,
          title: p.title,
          content: p.content,
          imageUrls: (p.image_urls ?? []) as string[],
          videoUrls: ((p as Record<string, unknown>).video_urls ?? []) as string[],
          likeCount: p.like_count,
          commentCount: p.comment_count,
          isReported: false,
          createdAt: p.created_at,
          author: {
            nickname: (profile?.nickname as string) || "익명",
            avatarUrl: null,
            myTeamId: ((p as Record<string, unknown>).author_team_id_snapshot as number | null | undefined) ?? (profile?.team_id as number | null) ?? null,
            level: 1,
            title: "",
            grade: profile?.grade as string | undefined,
          },
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
      .filter((p) => nowMs - new Date(p.createdAt).getTime() < 30 * 24 * 60 * 60 * 1000)
      .sort((a, b) => b.likeCount - a.likeCount || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [posts, sortTab, nowMs]);

  const sourceLabels = useMemo(
    () => Object.fromEntries(sortedPosts.map((post) => [post.id, getCommunitySourceLabel(post.boardType, post.boardId)])),
    [sortedPosts],
  );

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="px-5 pt-4 pb-2">
        <p className="text-sm text-text-tertiary">팀, 선수, 자유게시판 글을 한 번에 봅니다.</p>
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

      <div className="px-5">
        {loading ? (
          <div className="space-y-3 py-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="glass-card p-5 animate-pulse">
                <div className="h-4 bg-bg-tertiary rounded w-24 mb-3" />
                <div className="h-5 bg-bg-tertiary rounded w-3/4 mb-2" />
                <div className="h-4 bg-bg-tertiary rounded w-full" />
              </div>
            ))}
          </div>
        ) : (
          <PostList posts={sortedPosts} sourceLabels={sourceLabels} />
        )}
      </div>
    </div>
  );
}
