"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Pencil } from "lucide-react";
import { getTeamBySlug } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";
import PostList from "@/components/community/PostList";
import WritePost from "@/components/community/WritePost";
import type { Post } from "@/lib/types";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { usePosts, createPost } from "@/lib/supabase/usePosts";
import { supabase } from "@/lib/supabase/client";

type PageTab = "team" | "player";
type SortTab = "latest" | "hot";

export default function CommunityTeamBoardPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);

  // URL-driven state
  const initialTab = (searchParams.get("tab") as PageTab) || "team";
  const initialSort = (searchParams.get("sort") as SortTab) || "latest";
  const [pageTab, setPageTab] = useState<PageTab>(initialTab);
  const [sortTab, setSortTab] = useState<SortTab>(initialSort);
  const [writeOpen, setWriteOpen] = useState(false);
  const [writePlayerTarget, setWritePlayerTarget] = useState<string | null>(null);
  const [playerPickerOpen, setPlayerPickerOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const { user, profile } = useAuth();

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  // Update URL when tab/sort changes
  const updateUrl = useCallback(
    (tab: PageTab, sort: SortTab) => {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      url.searchParams.set("sort", sort);
      window.history.replaceState(null, "", url.toString());
    },
    []
  );

  const handleTabChange = (tab: PageTab) => {
    setPageTab(tab);
    setSortTab("latest"); // reset sort on tab change
    updateUrl(tab, "latest");
    window.scrollTo(0, 0);
  };

  const handleSortChange = (sort: SortTab) => {
    setSortTab(sort);
    updateUrl(pageTab, sort);
    window.scrollTo(0, 0);
  };

  // ── Team board posts ──
  const { posts: livePosts, loading: postsLoading, reload } = usePosts("team", teamSlug);
  const teamPosts: Post[] = livePosts.map((p) => ({
    id: p.id,
    boardType: "team" as const,
    boardId: teamSlug,
    authorId: p.author_id,
    title: p.title,
    content: p.content,
    imageUrls: p.image_urls || [],
    likeCount: p.like_count,
    commentCount: p.comment_count,
    isReported: false,
    createdAt: p.created_at,
    author: {
      nickname: p.nickname || "익명",
      avatarUrl: null,
      myTeamId: p.team_id || team.id,
      level: 1,
      title: "",
      grade: p.grade,
    },
  }));

  // Sort team posts
  const sortedTeamPosts = sortTab === "hot"
    ? [...teamPosts]
        .filter((p) => {
          const d = new Date(p.createdAt);
          return Date.now() - d.getTime() < 30 * 24 * 60 * 60 * 1000; // 30 days
        })
        .sort((a, b) => b.likeCount - a.likeCount || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : teamPosts; // already sorted by created_at desc from usePosts

  // ── Player board posts (favorite players) ──
  const [favPlayerIds, setFavPlayerIds] = useState<string[]>([]);
  const [favPlayerNames, setFavPlayerNames] = useState<Record<string, string>>({});
  const [playerPosts, setPlayerPosts] = useState<Post[]>([]);
  const [playerPostsLoading, setPlayerPostsLoading] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null); // null = all

  // Load favorite players
  useEffect(() => {
    try {
      const stored = localStorage.getItem("kbo-fav-players");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setFavPlayerIds(parsed);
          // Build name map from roster
          try {
            const roster = require("@/lib/constants/players-roster.json") as any[];
            const nameMap: Record<string, string> = {};
            parsed.forEach((id: string) => {
              const player = roster.find((p: any) => String(p.playerId) === String(id));
              if (player) nameMap[id] = player.name;
            });
            setFavPlayerNames(nameMap);
          } catch {
            // roster not available
          }
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Load player posts when switching to player tab
  useEffect(() => {
    if (pageTab !== "player" || favPlayerIds.length === 0) return;

    async function loadPlayerPosts() {
      setPlayerPostsLoading(true);

      // Query player board posts for all favorite players
      let query = supabase
        .from("posts")
        .select("id, author_id, board_type, board_id, title, content, image_urls, like_count, comment_count, created_at, is_hidden, profiles(nickname, team_id, grade)")
        .eq("board_type", "player")
        .in("board_id", favPlayerIds)
        .neq("is_hidden", true);

      if (sortTab === "hot") {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        query = query.gte("created_at", thirtyDaysAgo);
        query = query.order("like_count", { ascending: false });
      } else {
        query = query.order("created_at", { ascending: false });
      }

      query = query.limit(100);

      const { data } = await query;

      if (data) {
        setPlayerPosts(
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
              myTeamId: p.profiles?.team_id || team!.id,
              level: 1,
              title: "",
              grade: p.profiles?.grade,
            },
          }))
        );
      }
      setPlayerPostsLoading(false);
    }

    loadPlayerPosts();
  }, [pageTab, favPlayerIds, sortTab, team.id]);

  // Filter player posts by selected chip
  const filteredPlayerPosts = selectedPlayer
    ? playerPosts.filter((p) => p.boardId === selectedPlayer)
    : playerPosts;

  return (
    <div className="mx-auto max-w-lg">
      {/* Team header (compact) */}
      <div
        className="relative px-5 pb-3"
        style={{
          background: `linear-gradient(180deg, ${team.colorPrimary}33 0%, transparent 100%)`,
        }}
      >
        <div className="flex items-center gap-4 py-4">
          <button
            onClick={() => router.push("/community/teams?pick=true")}
            className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary/50 transition-colors"
          >
            <ChevronLeft size={24} />
          </button>
          <div className="flex items-center gap-3 flex-1">
            <TeamLogo team={team} size={48} />
            <h1 className="text-xl font-bold text-text-primary">{team.name}</h1>
          </div>
          <Link
            href="/community/teams?pick=true"
            className="rounded-full px-3 py-1.5 text-xs font-medium bg-bg-glass text-text-secondary hover:bg-bg-tertiary transition-colors"
          >
            다른 팀
          </Link>
        </div>
      </div>

      {/* Controls: toggles + write CTA */}
      <div className="px-5 pb-2 space-y-3">
        {/* Row 1: Tab toggle + Write CTA */}
        <div className="flex items-center justify-between">
          <div className="flex bg-bg-glass rounded-xl p-1">
            {(["team", "player"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => handleTabChange(tab)}
                className={`relative px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
                  pageTab === tab
                    ? "bg-text-primary text-bg-primary shadow-sm"
                    : "text-text-tertiary hover:text-text-secondary"
                }`}
              >
                {tab === "team" ? "팀 게시판" : "선수 게시판"}
              </button>
            ))}
          </div>

          {/* Write CTA — 상단 고정 */}
          <button
            onClick={() => {
              if (!user) {
                setShowLogin(true);
                return;
              }
              if (pageTab === "player") {
                // 선수 탭: 선수 선택 후 글쓰기
                if (favPlayerIds.length === 0) {
                  // 최애선수 0명 → 선수 선택 유도
                  router.push("/my");
                  return;
                }
                if (favPlayerIds.length === 1 || selectedPlayer) {
                  // 1명이거나 이미 칩 선택됨 → 바로 글쓰기
                  setWritePlayerTarget(selectedPlayer || favPlayerIds[0]);
                  setWriteOpen(true);
                } else {
                  // 2명 이상 → 선수 선택 시트 열기
                  setPlayerPickerOpen(true);
                }
              } else {
                setWritePlayerTarget(null);
                setWriteOpen(true);
              }
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors"
            style={{ backgroundColor: team.colorPrimary }}
          >
            <Pencil size={16} />
            글쓰기
          </button>
        </div>

        {/* Row 2: Sort toggle */}
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
            <span className="flex items-center text-xs text-text-tertiary ml-1">최근 30일</span>
          )}
        </div>

        {/* Player chip filters (only on player tab) */}
        {pageTab === "player" && favPlayerIds.length > 0 && (
          <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
            <button
              onClick={() => setSelectedPlayer(null)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                selectedPlayer === null
                  ? "text-white"
                  : "bg-bg-glass text-text-secondary"
              }`}
              style={selectedPlayer === null ? { backgroundColor: team.colorPrimary } : {}}
            >
              전체
            </button>
            {favPlayerIds.map((pid) => (
              <button
                key={pid}
                onClick={() => setSelectedPlayer(pid)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                  selectedPlayer === pid
                    ? "text-white"
                    : "bg-bg-glass text-text-secondary"
                }`}
                style={selectedPlayer === pid ? { backgroundColor: team.colorPrimary } : {}}
              >
                {favPlayerNames[pid] || pid}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {pageTab === "team" ? (
          <motion.div
            key="team-board"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.15 }}
            className="px-5 py-3"
          >
            {postsLoading ? (
              <div className="space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="glass-card p-5 animate-pulse">
                    <div className="h-4 bg-bg-tertiary rounded w-24 mb-3" />
                    <div className="h-5 bg-bg-tertiary rounded w-3/4 mb-2" />
                    <div className="h-4 bg-bg-tertiary rounded w-full" />
                  </div>
                ))}
              </div>
            ) : (
              <PostList posts={sortedTeamPosts} />
            )}
          </motion.div>
        ) : (
          <motion.div
            key="player-board"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ duration: 0.15 }}
            className="px-5 py-3"
          >
            {favPlayerIds.length === 0 ? (
              /* Empty state: no favorite players */
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-base text-text-tertiary mb-2">
                  최애선수를 선택하면<br />선수 게시판이 열려요
                </p>
                <Link
                  href="/my"
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors"
                  style={{ backgroundColor: team.colorPrimary }}
                >
                  선수 선택하기
                </Link>
              </div>
            ) : playerPostsLoading ? (
              <div className="space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="glass-card p-5 animate-pulse">
                    <div className="h-4 bg-bg-tertiary rounded w-24 mb-3" />
                    <div className="h-5 bg-bg-tertiary rounded w-3/4 mb-2" />
                    <div className="h-4 bg-bg-tertiary rounded w-full" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {/* Player label on each post */}
                {filteredPlayerPosts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
                    <p className="text-base">아직 글이 없습니다</p>
                    <p className="mt-1 text-base">최애선수 게시판에 첫 글을 작성해보세요!</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredPlayerPosts.map((post) => (
                      <div key={post.id}>
                        {/* Player name label */}
                        {!selectedPlayer && (
                          <div className="mb-1">
                            <span
                              className="inline-block px-2 py-0.5 rounded-md text-xs font-semibold text-white"
                              style={{ backgroundColor: team.colorPrimary + "CC" }}
                            >
                              {favPlayerNames[post.boardId] || post.boardId}
                            </span>
                          </div>
                        )}
                        <PostList posts={[post]} />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Player picker sheet (선수 2명 이상일 때 글쓰기 전 선택) */}
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
              className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-bg-secondary"
              style={{ maxHeight: "50vh" }}
            >
              <div className="flex justify-center pt-2">
                <div className="h-1 w-10 rounded-full bg-text-tertiary" />
              </div>
              <div className="px-5 py-4">
                <h3 className="text-lg font-semibold text-text-primary mb-4">어떤 선수 게시판에 쓸까요?</h3>
                <div className="space-y-2">
                  {favPlayerIds.map((pid) => (
                    <button
                      key={pid}
                      onClick={() => {
                        setWritePlayerTarget(pid);
                        setPlayerPickerOpen(false);
                        setWriteOpen(true);
                      }}
                      className="w-full text-left rounded-xl bg-bg-tertiary px-4 py-3 text-base font-medium text-text-primary hover:bg-bg-glass transition-colors"
                    >
                      {favPlayerNames[pid] || pid}
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
            : team.name
        }
        onSubmit={async (title, content, imageUrls) => {
          await createPost({
            boardType: writePlayerTarget ? "player" : "team",
            boardId: writePlayerTarget || teamSlug,
            title,
            content,
            imageUrls,
          });
          reload();
          setWriteOpen(false);
          setWritePlayerTarget(null);
        }}
      />
      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
