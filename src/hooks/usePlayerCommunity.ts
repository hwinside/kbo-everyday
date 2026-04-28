"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";
import { getFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import type { Post } from "@/lib/supabase/usePosts";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

interface SupabaseProfileJoin {
  nickname?: string;
  team_id?: number;
  grade?: string;
  points?: number;
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
  video_urls?: string[];
  like_count: number;
  comment_count: number;
  created_at: string;
  updated_at?: string | null;
  is_hidden: boolean;
  game_id?: string | null;
  player_tags?: string[];
  hashtags?: string[];
  profiles?: SupabaseProfileJoin | SupabaseProfileJoin[] | null;
}

export type ContentTab = "general" | "photo";
export type SortTab = "latest" | "hot";
// Filter mode: null = favorites all, "myTeam" = user's team all, string = specific player
export type PlayerFilter = null | "myTeam" | string;

function mapPost(row: SupabasePostRow): Post {
  const prof = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return {
    id: row.id,
    author_id: row.author_id,
    board_type: row.board_type,
    board_id: row.board_id,
    content_type: (row.content_type ?? "general") as "general" | "photo",
    title: row.title,
    content: row.content,
    image_urls: row.image_urls ?? [],
    video_urls: row.video_urls ?? [],
    like_count: row.like_count,
    comment_count: row.comment_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    game_id: row.game_id,
    player_tags: row.player_tags,
    hashtags: row.hashtags,
    nickname: prof?.nickname || "익명",
    team_id: prof?.team_id,
    grade: prof?.grade,
    points: prof?.points ?? 0,
  };
}

export function usePlayerCommunity(userTeamId?: number) {
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const [favLoaded, setFavLoaded] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortTab, setSortTab] = useState<SortTab>("latest");
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerFilter>(null);

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

  // My team roster player IDs
  const myTeamPlayerIds = useMemo(() => {
    if (!userTeamId) return [];
    return PLAYERS_ROSTER.filter((p) => p.teamId === userTeamId).map((p) => p.kboId);
  }, [userTeamId]);

  // Resolve which player IDs to query
  const getQueryIds = useCallback((): string[] => {
    if (selectedPlayer === "myTeam") return myTeamPlayerIds;
    if (selectedPlayer && selectedPlayer !== "myTeam") return [selectedPlayer];
    return favPlayerIds; // null = favorites all
  }, [selectedPlayer, favPlayerIds, myTeamPlayerIds]);

  // Load unified player posts (general + photo merged)
  const loadPosts = useCallback(async () => {
    const queryIds = getQueryIds();
    if (queryIds.length === 0) {
      setPosts([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    let query = supabase
      .from("posts")
      .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, updated_at, is_hidden, game_id, player_tags, hashtags, profiles(nickname, team_id, grade, points)")
      .eq("board_type", "player")
      // no content_type filter — show text and photo posts in one feed
      .in("board_id", queryIds)
      .neq("is_hidden", true);

    if (sortTab === "hot") {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      query = query
        .gte("created_at", sevenDaysAgo)
        .order("like_count", { ascending: false })
        .order("created_at", { ascending: false });
    } else {
      query = query.order("created_at", { ascending: false });
    }

    query = query.limit(50);
    const { data } = await query;

    setPosts(((data ?? []) as unknown as SupabasePostRow[]).map(mapPost));
    setLoading(false);
  }, [getQueryIds, sortTab]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPosts();
  }, [loadPosts]);

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
    sortTab,
    selectedPlayer,
    setSelectedPlayer,
    posts,
    handleSortChange,
    loadPosts,
  };
}
