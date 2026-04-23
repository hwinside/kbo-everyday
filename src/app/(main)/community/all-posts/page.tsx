"use client";

import { useEffect, useMemo, useState } from "react";
import UnifiedFeed from "@/components/community/UnifiedFeed";
import type { Post } from "@/lib/supabase/usePosts";
import { supabase } from "@/lib/supabase/client";
import { getCommunitySourceLabel } from "@/lib/utils/community-board";

export default function AllPostsPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from("posts")
        .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, updated_at, is_hidden, game_id, player_tags, hashtags, profiles(nickname, team_id, grade, points)")
        .in("board_type", ["team", "player", "free"])
        // no content_type filter — show both general and photo
        .neq("is_hidden", true)
        .order("created_at", { ascending: false })
        .limit(100);

      if (cancelled) return;

      setPosts((data ?? []).map((p) => {
        const profileRaw = Array.isArray(p.profiles) ? p.profiles[0] : p.profiles;
        const profile = (profileRaw ?? null) as unknown as Record<string, unknown> | null;
        return {
          id: p.id as number,
          author_id: p.author_id as string,
          board_type: p.board_type as string,
          board_id: p.board_id as string,
          content_type: ((p.content_type as string) ?? "general") as "general" | "photo",
          title: p.title as string,
          content: p.content as string,
          image_urls: (p.image_urls ?? []) as string[],
          video_urls: ((p as Record<string, unknown>).video_urls ?? []) as string[],
          like_count: p.like_count as number,
          comment_count: p.comment_count as number,
          created_at: p.created_at as string,
          updated_at: (p as Record<string, unknown>).updated_at as string | null | undefined,
          game_id: (p as Record<string, unknown>).game_id as string | null | undefined,
          player_tags: (p as Record<string, unknown>).player_tags as string[] | undefined,
          hashtags: (p as Record<string, unknown>).hashtags as string[] | undefined,
          nickname: (profile?.nickname as string) || "익명",
          team_id: (profile?.team_id as number | undefined) ?? undefined,
          grade: profile?.grade as string | undefined,
          points: ((profile?.points as number) ?? 0),
        };
      }));
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const sourceLabels = useMemo(
    () => Object.fromEntries(posts.map((post) => [post.id, getCommunitySourceLabel(post.board_type as "team" | "player" | "free", post.board_id)])),
    [posts],
  );

  const handleLike = async (postId: number) => {
    const { toggleLike } = await import("@/lib/supabase/usePosts");
    try { await toggleLike(postId); } catch { /* ignore */ }
  };

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="px-5 pt-4 pb-2">
        <p className="text-sm text-text-tertiary">팀, 선수, 자유게시판 글을 한 번에 봅니다.</p>
      </div>

      <div className="py-3">
        <UnifiedFeed
          posts={posts}
          loading={loading}
          onLike={handleLike}
          boardContext={{ type: "global" }}
          sourceLabels={sourceLabels}
        />
      </div>
    </div>
  );
}
