"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { getTeamBySlug, getTeamBgColor } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";
import PhotoFeed from "@/components/community/PhotoFeed";
import WritePost from "@/components/community/WritePost";
import EventBanner from "@/components/home/EventBanner";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";
import { useUnifiedFeed } from "@/lib/supabase/useUnifiedFeed";

export default function CommunityTeamBoardPage() {
  const params = useParams();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);

  const [writeOpen, setWriteOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const { user } = useAuth();

  // 글·사진 한 스트림 통합 피드 (전체글/팀/선수 동일 컴포넌트 공유).
  const { posts, likedIds, loading, loadingMore, hasMore, loadMore, setPostLiked, reload } =
    useUnifiedFeed({ kind: "team", teamId: teamSlug });

  // 좋아요: optimistic 토글 → 서버 반영 → 실패/불일치 시 롤백·reconcile. 비로그인은 no-op.
  const handleLike = useCallback(
    async (postId: number) => {
      if (!user) return;
      const wasLiked = likedIds.has(postId);
      const next = !wasLiked;
      setPostLiked(postId, next);
      try {
        const serverLiked = await toggleLike(postId);
        if (serverLiked !== next) setPostLiked(postId, serverLiked);
      } catch {
        setPostLiked(postId, wasLiked);
      }
    },
    [user, likedIds, setPostLiked],
  );

  // 무한 스크롤 — 하단 센티넬 진입 시 다음 페이지 로드.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
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

      {/* 이벤트 배너 (2026-04-20 — 얼리멤버 초대/글쓰기) */}
      <div className="px-5">
        <EventBanner source="community" />
      </div>

      {/* 통합 피드 (글·사진 혼합, 최신순 단일) */}
      <div className="pt-2">
        <PhotoFeed posts={posts} loading={loading} onLike={handleLike} likedIds={likedIds} />
      </div>

      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-6 text-sm text-text-tertiary">
          {loadingMore ? "불러오는 중…" : ""}
        </div>
      )}

      {/* FAB */}
      <button
        onClick={() => (user ? setWriteOpen(true) : setShowLogin(true))}
        className="fixed bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
      >
        <Pencil size={24} />
      </button>

      {/* Write post modal (글·사진 첨부 통합 — 밈 에디터/태그는 S5 통합 컴포저로 이관 예정) */}
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
            // V3 태그 모델: 팀 게시판 글은 해당 팀 태그를 자동 부여해야
            // team_tags 기준 팀 피드(ad1987be)에 노출됨. 누락 시 자기 팀 탭에서 사라짐.
            teamTags: [teamSlug],
          });
          reload();
          setWriteOpen(false);
        }}
      />

      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
