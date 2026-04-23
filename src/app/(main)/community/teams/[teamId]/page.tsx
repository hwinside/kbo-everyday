"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AnimatePresence } from "framer-motion";
import { Pencil, X, Camera, FileText } from "lucide-react";
import { getTeamBySlug, getTeamBgColor } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";
import UnifiedFeed from "@/components/community/UnifiedFeed";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import EventBanner from "@/components/home/EventBanner";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { useUnifiedPosts } from "@/lib/supabase/useUnifiedPosts";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";

export default function CommunityTeamBoardPage() {
  const params = useParams();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);

  const [writeOpen, setWriteOpen] = useState(false);
  const [writePhotoOpen, setWritePhotoOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [fabExpanded, setFabExpanded] = useState(false);

  const { user } = useAuth();

  // Unified posts (general + photo merged)
  const { posts, loading, reload } = useUnifiedPosts("team", teamSlug);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  const handleLike = async (postId: number) => {
    try { await toggleLike(postId); } catch { /* ignore */ }
  };

  const handleFabClick = () => {
    if (!user) { setShowLogin(true); return; }
    setFabExpanded(prev => !prev);
  };

  return (
    <div className="mx-auto max-w-lg">
      {/* Team header (compact) */}
      <div
        className="relative px-5 pb-3"
        style={{
          background: `linear-gradient(180deg, ${getTeamBgColor(team)}33 0%, transparent 100%)`,
        }}
      >
        <div className="flex items-center gap-4 py-4">
          <div className="flex items-center gap-3 flex-1">
            <TeamLogo team={team} size={48} />
            <h1 className="text-lg font-semibold text-text-primary">{team.name}</h1>
          </div>
          <Link
            href="/community/teams?pick=true"
            className="rounded-full px-3 py-1.5 text-xs font-medium bg-bg-glass text-text-secondary hover:bg-bg-tertiary transition-colors"
          >
            다른 팀
          </Link>
        </div>
      </div>

      {/* 이벤트 배너 */}
      <div className="px-5">
        <EventBanner source="community" />
      </div>

      {/* Unified feed */}
      <div className="py-3">
        <UnifiedFeed
          posts={posts}
          loading={loading}
          onLike={handleLike}
          boardContext={{ type: "team", teamId: team.id }}
        />
      </div>

      {/* FAB with write type selection */}
      <div className="fixed bottom-24 right-5 z-40 flex flex-col-reverse items-center gap-3">
        <AnimatePresence>
          {fabExpanded && (
            <>
              {/* Write text post */}
              <button
                onClick={() => { setFabExpanded(false); setWriteOpen(true); }}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-tertiary text-text-primary shadow-lg transition-transform hover:scale-105 active:scale-95"
              >
                <FileText size={20} />
              </button>
              {/* Write photo post */}
              <button
                onClick={() => { setFabExpanded(false); setWritePhotoOpen(true); }}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-tertiary text-text-primary shadow-lg transition-transform hover:scale-105 active:scale-95"
              >
                <Camera size={20} />
              </button>
            </>
          )}
        </AnimatePresence>
        <button
          onClick={handleFabClick}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
        >
          {fabExpanded ? <X size={24} /> : <Pencil size={24} />}
        </button>
      </div>

      {/* Backdrop when FAB expanded */}
      {fabExpanded && (
        <div className="fixed inset-0 z-30" onClick={() => setFabExpanded(false)} />
      )}

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
          reload();
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
        onSuccess={() => reload()}
      />

      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
