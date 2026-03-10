"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";
import { getFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import type { Post } from "@/lib/types";
import type { Post as RawPost } from "@/lib/supabase/usePosts";

interface SupabaseProfileJoin {
  nickname?: string;
  team_id?: number;
  grade?: string;
}

interface SupabasePostRow {
  id: number;
  author_id: string;
  board_type: string;
  board_id: string;
  content_type?: string;
  title: string;
  content: string;
  image_urls?: string[];
  like_count: number;
  comment_count: number;
  created_at: string;
  is_hidden: boolean;
  profiles?: SupabaseProfileJoin | SupabaseProfileJoin[] | null;
}

export type ContentTab = "general" | "photo";
export type SortTab = "latest" | "hot";

export function usePlayerCommunity() {
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const [favLoaded, setFavLoaded] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [photoPosts, setPhotoPosts] = useState<RawPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [contentTab, setContentTab] = useState<ContentTab>("general");
  const [sortTab, setSortTab] = useState<SortTab>("latest");
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);

  // Derived
  const favPlayerIds = useMemo(() => favPlayers.map((p) => p.playerId), [favPlayers]);
  const favPlayerNames = useMemo(() => {
    const m: Record<string, string> = {};
    favPlayers.forEach((p) => { m[p.playerId] = p.name; });
    return m;
  }, [favPlayers]);

  // Load favorites
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFavPlayers(getFavoritePlayers());
    setFavLoaded(true);
  }, []);

  // Load general posts
  const loadPosts = useCallback(async () => {
    if (favPlayerIds.length === 0) return;
    setLoading(true);

    let query = supabase
      .from("posts")
      .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, like_count, comment_count, created_at, is_hidden, profiles(nickname, team_id, grade)")
      .eq("board_type", "player")
      .eq("content_type", "general")
      .in("board_id", favPlayerIds)
      .neq("is_hidden", true);

    if (sortTab === "hot") {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      query = query
        .gte("created_at", sevenDaysAgo)
        .order("like_count", { ascending: false });
    } else {
      query = query.order("created_at", { ascending: false });
    }

    query = query.limit(50);
    const { data } = await query;

    if (data) {
      const rows = data as unknown as SupabasePostRow[];
      setPosts(
        rows.map((p) => {
          const prof = Array.isArray(p.profiles) ? p.profiles[0] : p.profiles;
          return {
            id: p.id,
            boardType: "player" as const,
            boardId: p.board_id,
            authorId: p.author_id,
            title: p.title,
            content: p.content,
            imageUrls: p.image_urls ?? [],
            likeCount: p.like_count,
            commentCount: p.comment_count,
            isReported: false,
            createdAt: p.created_at,
            author: {
              nickname: prof?.nickname || "익명",
              avatarUrl: null,
              myTeamId: prof?.team_id || 0,
              level: 1,
              title: "",
              grade: prof?.grade,
            },
          };
        })
      );
    }
    setLoading(false);
  }, [favPlayerIds, sortTab]);

  // Load photo posts
  const loadPhotoPosts = useCallback(async () => {
    if (favPlayerIds.length === 0) return;
    setPhotoLoading(true);

    let query = supabase
      .from("posts")
      .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, like_count, comment_count, created_at, is_hidden, profiles(nickname, team_id, grade)")
      .eq("board_type", "player")
      .eq("content_type", "photo")
      .in("board_id", favPlayerIds)
      .neq("is_hidden", true);

    if (sortTab === "hot") {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      query = query
        .gte("created_at", sevenDaysAgo)
        .order("like_count", { ascending: false });
    } else {
      query = query.order("created_at", { ascending: false });
    }

    query = query.limit(50);
    const { data } = await query;

    if (data) {
      const rows = data as unknown as SupabasePostRow[];
      setPhotoPosts(
        rows.map((p) => {
          const prof = Array.isArray(p.profiles) ? p.profiles[0] : p.profiles;
          return {
            id: p.id,
            author_id: p.author_id,
            board_type: p.board_type,
            board_id: p.board_id,
            content_type: (p.content_type ?? "photo") as "general" | "photo",
            title: p.title,
            content: p.content,
            image_urls: p.image_urls ?? [],
            like_count: p.like_count,
            comment_count: p.comment_count,
            created_at: p.created_at,
            nickname: prof?.nickname || "익명",
            team_id: prof?.team_id,
            grade: prof?.grade,
          };
        })
      );
    }
    setPhotoLoading(false);
  }, [favPlayerIds, sortTab]);

  useEffect(() => {
    if (favPlayerIds.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (contentTab === "general") loadPosts();
      else loadPhotoPosts();
    }
  }, [loadPosts, loadPhotoPosts, favPlayerIds.length, contentTab]);

  // Filter by selected chip
  const filteredPosts = selectedPlayer
    ? posts.filter((p) => p.boardId === selectedPlayer)
    : posts;

  const filteredPhotoPosts = selectedPlayer
    ? photoPosts.filter((p) => p.board_id === selectedPlayer)
    : photoPosts;

  // Handle tab change
  const handleTabChange = (tab: ContentTab) => {
    setContentTab(tab);
    setSortTab("latest");
    window.scrollTo(0, 0);
  };

  // Handle sort change
  const handleSortChange = (sort: SortTab) => {
    setSortTab(sort);
    window.scrollTo(0, 0);
  };

  return {
    favPlayers,
    favLoaded,
    favPlayerIds,
    favPlayerNames,
    loading,
    photoLoading,
    contentTab,
    sortTab,
    selectedPlayer,
    setSelectedPlayer,
    filteredPosts,
    filteredPhotoPosts,
    handleTabChange,
    handleSortChange,
    loadPosts,
    loadPhotoPosts,
  };
}
