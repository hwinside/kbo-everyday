"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import type { Post } from "./usePosts";

const COLS =
  "id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, updated_at, is_hidden, game_id, player_tags, hashtags, profiles(nickname, team_id, grade, points)";

function mapRow(p: Record<string, unknown>): Post {
  const profiles = p.profiles as Record<string, unknown> | null;
  return {
    id: p.id as number,
    author_id: p.author_id as string,
    board_type: p.board_type as string,
    board_id: p.board_id as string,
    content_type: ((p.content_type as string) ?? "general") as "general" | "photo",
    title: p.title as string,
    content: p.content as string,
    image_urls: (p.image_urls ?? []) as string[],
    video_urls: (p.video_urls ?? []) as string[],
    like_count: p.like_count as number,
    comment_count: p.comment_count as number,
    created_at: p.created_at as string,
    updated_at: p.updated_at as string | null | undefined,
    game_id: p.game_id as string | null | undefined,
    player_tags: p.player_tags as string[] | undefined,
    hashtags: p.hashtags as string[] | undefined,
    nickname: profiles?.nickname as string | undefined,
    team_id: profiles?.team_id as number | undefined,
    grade: profiles?.grade as string | undefined,
    points: (profiles?.points as number) ?? 0,
  };
}

/**
 * Unified posts hook — fetches both general + photo content types merged
 * in a single chronological feed.
 */
export function useUnifiedPosts(boardType: string, boardId: string, limit = 50) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchPosts() {
      setLoading(true);
      const { data } = await supabase
        .from("posts")
        .select(COLS)
        .eq("board_type", boardType)
        .eq("board_id", boardId)
        // no content_type filter — fetch both general and photo
        .neq("is_hidden", true)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (cancelled) return;
      if (data) {
        setPosts(data.map((p) => mapRow(p as unknown as Record<string, unknown>)));
      }
      setLoading(false);
    }

    fetchPosts();
    return () => { cancelled = true; };
  }, [boardType, boardId, limit]);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("posts")
      .select(COLS)
      .eq("board_type", boardType)
      .eq("board_id", boardId)
      .neq("is_hidden", true)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (data) {
      setPosts(data.map((p) => mapRow(p as unknown as Record<string, unknown>)));
    }
    setLoading(false);
  }, [boardType, boardId, limit]);

  return { posts, loading, reload };
}
