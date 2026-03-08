"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Pencil } from "lucide-react";
import { getTeamBySlug } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";
import PostList from "@/components/community/PostList";
import PhotoFeed from "@/components/community/PhotoFeed";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import type { Post } from "@/lib/types";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { usePosts, createPost } from "@/lib/supabase/usePosts";
import { toggleLike } from "@/lib/supabase/usePosts";

type ContentTab = "general" | "photo";
type SortTab = "latest" | "hot";

export default function CommunityTeamBoardPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);

  // URL-driven state
  const initialTab = (searchParams.get("tab") as ContentTab) || "general";
  const initialSort = (searchParams.get("sort") as SortTab) || "latest";
  const [contentTab, setContentTab] = useState<ContentTab>(initialTab);
  const [sortTab, setSortTab] = useState<SortTab>(initialSort);
  const [writeOpen, setWriteOpen] = useState(false);
  const [writePhotoOpen, setWritePhotoOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const { user } = useAuth();

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  // Update URL when tab/sort changes
  const updateUrl = useCallback(
    (tab: ContentTab, sort: SortTab) => {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      url.searchParams.set("sort", sort);
      window.history.replaceState(null, "", url.toString());
    },
    []
  );

  const handleTabChange = (tab: ContentTab) => {
    setContentTab(tab);
    setSortTab("latest");
    updateUrl(tab, "latest");
    window.scrollTo(0, 0);
  };

  const handleSortChange = (sort: SortTab) => {
    setSortTab(sort);
    updateUrl(contentTab, sort);
    window.scrollTo(0, 0);
  };

  // ── General posts ──
  const { posts: generalLivePosts, loading: generalLoading, reload: reloadGeneral } = usePosts("team", teamSlug, "general");
  const generalPosts: Post[] = generalLivePosts.map((p) => ({
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

  const sortedGeneralPosts = sortTab === "hot"
    ? [...generalPosts]
        .filter((p) => {
          const d = new Date(p.createdAt);
          return Date.now() - d.getTime() < 30 * 24 * 60 * 60 * 1000;
        })
        .sort((a, b) => b.likeCount - a.likeCount || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : generalPosts;

  // ── Photo posts ──
  const { posts: photoPosts, loading: photoLoading, reload: reloadPhoto } = usePosts("team", teamSlug, "photo");

  const sortedPhotoPosts = sortTab === "hot"
    ? [...photoPosts]
        .filter((p) => {
          const d = new Date(p.created_at);
          return Date.now() - d.getTime() < 30 * 24 * 60 * 60 * 1000;
        })
        .sort((a, b) => b.like_count - a.like_count || new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    : photoPosts;

  const handlePhotoLike = async (postId: number) => {
    try {
      await toggleLike(postId);
    } catch {
      // ignore if not logged in
    }
  };

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

      {/* Controls */}
      <div className="px-5 pb-2 space-y-3">
        {/* Row 1: Tab toggle + Write CTA */}
        <div className="flex items-center justify-between">
          <div className="flex bg-bg-glass rounded-xl p-1">
            {(["general", "photo"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => handleTabChange(tab)}
                className={`relative px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
                  contentTab === tab
                    ? "bg-text-primary text-bg-primary shadow-sm"
                    : "text-text-tertiary hover:text-text-secondary"
                }`}
              >
                {tab === "general" ? "일반" : "사진"}
              </button>
            ))}
          </div>

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
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {contentTab === "general" ? (
          <motion.div
            key="general-board"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.15 }}
            className="px-5 py-3"
          >
            {generalLoading ? (
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
              <PostList posts={sortedGeneralPosts} />
            )}
          </motion.div>
        ) : (
          <motion.div
            key="photo-board"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ duration: 0.15 }}
            className="py-3"
          >
            <PhotoFeed
              posts={sortedPhotoPosts}
              loading={photoLoading}
              onLike={handlePhotoLike}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* FAB */}
      <button
        onClick={() => {
          if (!user) {
            setShowLogin(true);
            return;
          }
          if (contentTab === "photo") {
            setWritePhotoOpen(true);
          } else {
            setWriteOpen(true);
          }
        }}
        className="fixed bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
      >
        <Pencil size={24} />
      </button>

      {/* Write post modal (general) */}
      <WritePost
        isOpen={writeOpen}
        onClose={() => setWriteOpen(false)}
        teamName={team.name}
        onSubmit={async (title, content, imageUrls) => {
          await createPost({
            boardType: "team",
            boardId: teamSlug,
            title,
            content,
            imageUrls,
            contentType: "general",
          });
          reloadGeneral();
          setWriteOpen(false);
        }}
      />

      {/* Write photo post modal */}
      <WritePhotoPost
        isOpen={writePhotoOpen}
        onClose={() => setWritePhotoOpen(false)}
        teamName={team.name}
        boardType="team"
        boardId={teamSlug}
        onSuccess={() => reloadPhoto()}
      />

      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
