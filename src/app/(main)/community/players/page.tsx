"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Pencil, Search, Heart, MessageCircle } from "lucide-react";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import PostList from "@/components/community/PostList";
import WritePost from "@/components/community/WritePost";
import LoginSheet from "@/components/auth/LoginSheet";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";
import { createPost } from "@/lib/supabase/usePosts";
import { getFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";
import type { Post } from "@/lib/types";

type SortTab = "latest" | "hot";

export default function CommunityPlayersPage() {
  const router = useRouter();
  const { user } = useAuth();

  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const [favLoaded, setFavLoaded] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortTab, setSortTab] = useState<SortTab>("latest");
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null); // null = 전체
  const [writeOpen, setWriteOpen] = useState(false);
  const [writePlayerTarget, setWritePlayerTarget] = useState<string | null>(null);
  const [playerPickerOpen, setPlayerPickerOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  // Derived
  const favPlayerIds = useMemo(() => favPlayers.map((p) => p.playerId), [favPlayers]);
  const favPlayerNames = useMemo(() => {
    const m: Record<string, string> = {};
    favPlayers.forEach((p) => { m[p.playerId] = p.name; });
    return m;
  }, [favPlayers]);

  // Load favorites
  useEffect(() => {
    setFavPlayers(getFavoritePlayers());
    setFavLoaded(true);
  }, []);

  // Load posts for all favorite players
  const loadPosts = useCallback(async () => {
    if (favPlayerIds.length === 0) return;
    setLoading(true);

    let query = supabase
      .from("posts")
      .select("id, author_id, board_type, board_id, title, content, image_urls, like_count, comment_count, created_at, is_hidden, profiles(nickname, team_id, grade)")
      .eq("board_type", "player")
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
      setPosts(
        data.map((p: any) => ({
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
            nickname: p.profiles?.nickname || "익명",
            avatarUrl: null,
            myTeamId: p.profiles?.team_id || 0,
            level: 1,
            title: "",
            grade: p.profiles?.grade,
          },
        }))
      );
    }
    setLoading(false);
  }, [favPlayerIds, sortTab]);

  useEffect(() => {
    if (favPlayerIds.length > 0) loadPosts();
  }, [loadPosts, favPlayerIds.length]);

  // Filter by selected chip
  const filteredPosts = selectedPlayer
    ? posts.filter((p) => p.boardId === selectedPlayer)
    : posts;

  // Handle sort change
  const handleSortChange = (sort: SortTab) => {
    setSortTab(sort);
    window.scrollTo(0, 0);
  };

  // Handle write
  const handleWrite = () => {
    if (!user) {
      setShowLogin(true);
      return;
    }
    if (favPlayerIds.length === 0) {
      router.push("/my");
      return;
    }
    if (favPlayerIds.length === 1 || selectedPlayer) {
      setWritePlayerTarget(selectedPlayer || favPlayerIds[0]);
      setWriteOpen(true);
    } else {
      setPlayerPickerOpen(true);
    }
  };

  // Get team color for a player
  const getPlayerTeamColor = (playerId: string) => {
    const fav = favPlayers.find((p) => p.playerId === playerId);
    if (!fav) return "#E8364E";
    return TEAMS.find((t) => t.id === fav.teamId)?.colorPrimary || "#E8364E";
  };

  if (!favLoaded) {
    return (
      <div className="mx-auto max-w-lg px-5 pb-24">
        <div className="mt-8 space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="glass-card p-5 animate-pulse">
              <div className="h-4 bg-bg-tertiary rounded w-24 mb-3" />
              <div className="h-5 bg-bg-tertiary rounded w-3/4 mb-2" />
              <div className="h-4 bg-bg-tertiary rounded w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Empty state: no favorite players
  if (favPlayerIds.length === 0) {
    return (
      <div className="mx-auto max-w-lg px-5 pb-24">
        <div className="flex flex-col items-center justify-center py-28 text-center">
          <div className="text-5xl mb-4">⚾</div>
          <p className="text-lg font-bold text-text-primary mb-2">
            최애선수를 선택하면<br />선수 게시판이 열려요
          </p>
          <p className="text-sm text-text-tertiary mb-6">
            최대 5명의 최애선수를 등록하고<br />관련 글을 한 곳에서 모아보세요
          </p>
          <Link
            href="/my"
            className="inline-flex items-center gap-1.5 px-6 py-3 rounded-xl text-sm font-semibold text-white bg-accent transition-colors hover:bg-accent/90"
          >
            선수 선택하기
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg">
      {/* Controls */}
      <div className="px-5 pb-2 space-y-3">
        {/* Row 1: Title + Write CTA */}
        <div className="flex items-center justify-between pt-3">
          <h2 className="text-base font-bold text-text-primary">최애선수 게시판</h2>
          <button
            onClick={handleWrite}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-accent transition-colors hover:bg-accent/90"
          >
            <Pencil size={16} />
            글쓰기
          </button>
        </div>

        {/* Player chip filters */}
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          <button
            onClick={() => setSelectedPlayer(null)}
            className={`px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
              selectedPlayer === null
                ? "bg-accent text-white"
                : "bg-bg-glass text-text-secondary"
            }`}
          >
            전체
          </button>
          {favPlayers.map((player) => (
            <button
              key={player.playerId}
              onClick={() => setSelectedPlayer(player.playerId)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                selectedPlayer === player.playerId
                  ? "text-white"
                  : "bg-bg-glass text-text-secondary"
              }`}
              style={
                selectedPlayer === player.playerId
                  ? { backgroundColor: getPlayerTeamColor(player.playerId) }
                  : {}
              }
            >
              <PlayerAvatar
                name={player.name}
                teamId={player.teamId}
                photoUrl={getPlayerPhotoUrl(player.name)}
                size={22}
              />
              {player.name}
            </button>
          ))}
        </div>

        {/* Sort toggle */}
        <div className="flex gap-2">
          {(["latest", "hot"] as const).map((sort) => (
            <button
              key={sort}
              onClick={() => handleSortChange(sort)}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
                sortTab === sort
                  ? "bg-bg-tertiary text-text-primary"
                  : "text-text-tertiary hover:text-text-secondary"
              }`}
            >
              {sort === "latest" ? "최신" : "인기"}
            </button>
          ))}
          {sortTab === "hot" && (
            <span className="flex items-center text-xs text-text-tertiary ml-1">최근 7일</span>
          )}
        </div>
      </div>

      {/* Posts */}
      <div className="px-5 py-3">
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="glass-card p-5 animate-pulse">
                <div className="h-4 bg-bg-tertiary rounded w-24 mb-3" />
                <div className="h-5 bg-bg-tertiary rounded w-3/4 mb-2" />
                <div className="h-4 bg-bg-tertiary rounded w-full" />
              </div>
            ))}
          </div>
        ) : filteredPosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
            <p className="text-base">아직 글이 없습니다</p>
            <p className="mt-1 text-sm">최애선수 게시판에 첫 글을 작성해보세요!</p>
          </div>
        ) : (
          <>
            {/* Player label on each post when showing "전체" */}
            {!selectedPlayer ? (
              <div className="space-y-3">
                {filteredPosts.map((post) => (
                  <div key={post.id}>
                    <div className="mb-1">
                      <span
                        className="inline-block px-2 py-0.5 rounded-md text-xs font-semibold text-white"
                        style={{ backgroundColor: getPlayerTeamColor(post.boardId) + "CC" }}
                      >
                        {favPlayerNames[post.boardId] || post.boardId}
                      </span>
                    </div>
                    <PostList posts={[post]} />
                  </div>
                ))}
              </div>
            ) : (
              <PostList posts={filteredPosts} />
            )}
          </>
        )}
      </div>

      {/* Player picker sheet */}
      <AnimatePresence>
        {playerPickerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/60"
              onClick={() => setPlayerPickerOpen(false)}
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-bg-secondary overflow-y-auto"
              style={{ maxHeight: "92dvh" }}
            >
              <div className="flex justify-center pt-3">
                <div className="h-1 w-10 rounded-full bg-text-tertiary" />
              </div>
              <div className="flex flex-col h-full">
                <div className="sticky top-0 bg-bg-secondary px-5 pt-3 pb-2 z-10">
                  <h3 className="text-lg font-bold text-text-primary">어떤 선수 게시판에 쓸까요?</h3>
                </div>
                <div className="px-5 pb-24 space-y-2 overflow-y-auto flex-1">
                  {favPlayers.map((player) => (
                    <button
                      key={player.playerId}
                      onClick={() => {
                        setWritePlayerTarget(player.playerId);
                        setPlayerPickerOpen(false);
                        setWriteOpen(true);
                      }}
                      className="w-full flex items-center gap-3 text-left rounded-xl bg-bg-tertiary px-4 py-3 text-base font-semibold text-text-primary hover:bg-bg-glass active:scale-[0.98] transition-all"
                    >
                      <PlayerAvatar
                        name={player.name}
                        teamId={player.teamId}
                        photoUrl={getPlayerPhotoUrl(player.name)}
                        size={36}
                      />
                      {player.name}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Write post modal */}
      <WritePost
        isOpen={writeOpen}
        onClose={() => { setWriteOpen(false); setWritePlayerTarget(null); }}
        teamName={
          writePlayerTarget
            ? (favPlayerNames[writePlayerTarget] || writePlayerTarget) + " 게시판"
            : "선수 게시판"
        }
        onSubmit={async (title, content, imageUrls) => {
          await createPost({
            boardType: "player",
            boardId: writePlayerTarget || favPlayerIds[0],
            title,
            content,
            imageUrls,
          });
          setWriteOpen(false);
          setWritePlayerTarget(null);
          loadPosts();
        }}
      />

      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
