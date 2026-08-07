"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";
import { getFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import type { Post } from "@/lib/types";
import type { Post as RawPost } from "@/lib/supabase/usePosts";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

interface SupabaseProfileJoin {
  nickname?: string;
  team_id?: number;
  grade?: string;
  avatar_url?: string | null;
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
  is_hidden: boolean;
  author_team_id_snapshot?: number | null;
  click_view_count?: number | null;
  impression_view_count?: number | null;
  /** 공개범위 SSOT 입력 — 카드가 직접 계산하므로 조회 컬럼에 반드시 포함돼야 한다. */
  team_tags?: string[] | null;
  player_tags?: string[] | null;
  profiles?: SupabaseProfileJoin | SupabaseProfileJoin[] | null;
}

export type ContentTab = "general" | "photo";
export type SortTab = "latest" | "hot";
// Filter mode: null = favorites all, "myTeam" = user's team all, string = specific player
export type PlayerFilter = null | "myTeam" | string;

export function usePlayerCommunity(userTeamId?: number) {
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const [favLoaded, setFavLoaded] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [photoPosts, setPhotoPosts] = useState<RawPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [contentTab, setContentTab] = useState<ContentTab>("general");
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

  // Load general posts
  const loadPosts = useCallback(async () => {
    const queryIds = getQueryIds();
    if (queryIds.length === 0) return;
    setLoading(true);

    // query-guard: bounded -- 선택한 관심선수 집합의 최신 일반글 50개만 보여주는 단일 UI 페이지다.
    let query = supabase
      .from("posts")
      .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, author_team_id_snapshot, team_tags, player_tags, profiles(nickname, team_id, grade, avatar_url)")
      .eq("board_type", "player")
      .eq("content_type", "general")
      .in("board_id", queryIds)
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
            // 공개범위 SSOT — 카드가 직접 계산하도록 태그를 실어 보낸다.
            teamTags: p.team_tags ?? null,
            playerTags: p.player_tags ?? null,
            author: {
              nickname: prof?.nickname || "익명",
              avatarUrl: prof?.avatar_url ?? null,
              myTeamId: p.author_team_id_snapshot ?? prof?.team_id ?? 0,
              level: 1,
              title: "",
              grade: prof?.grade,
            },
          };
        })
      );
    }
    setLoading(false);
  }, [getQueryIds, sortTab]);

  // Load photo posts
  const loadPhotoPosts = useCallback(async () => {
    const queryIds = getQueryIds();
    if (queryIds.length === 0) return;
    setPhotoLoading(true);

    // query-guard: bounded -- 선택한 관심선수 집합의 최신 사진글 50개만 보여주는 단일 UI 페이지다.
    let query = supabase
      .from("posts")
      .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, author_team_id_snapshot, click_view_count, impression_view_count, team_tags, player_tags, profiles(nickname, team_id, grade, avatar_url)")
      .eq("board_type", "player")
      .eq("content_type", "photo")
      .in("board_id", queryIds)
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
            video_urls: p.video_urls ?? [],
            like_count: p.like_count,
            comment_count: p.comment_count,
            created_at: p.created_at,
            nickname: prof?.nickname || "익명",
            team_id: p.author_team_id_snapshot ?? prof?.team_id,
            grade: prof?.grade,
            avatar_url: prof?.avatar_url ?? undefined,
            click_view_count: p.click_view_count ?? 0,
            impression_view_count: p.impression_view_count ?? 0,
            // 공개범위 SSOT 입력 — 이 매핑은 필드를 명시 나열하므로 여기서 빠지면
            // SELECT 에 있어도 카드까지 안 간다. 다팀 글이 선수 보드 폴백으로
            // 조용히 축소된다(삼순 NO-GO 2026-08-07).
            team_tags: p.team_tags ?? undefined,
            player_tags: p.player_tags ?? undefined,
          };
        })
      );
    }
    setPhotoLoading(false);
  }, [getQueryIds, sortTab]);

  useEffect(() => {
    const queryIds = getQueryIds();
    if (queryIds.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (contentTab === "general") loadPosts();
      else loadPhotoPosts();
    }
  }, [loadPosts, loadPhotoPosts, getQueryIds, contentTab]);

  // With the new query-level filtering, no additional client-side filter needed
  const filteredPosts = posts;
  const filteredPhotoPosts = photoPosts;

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
