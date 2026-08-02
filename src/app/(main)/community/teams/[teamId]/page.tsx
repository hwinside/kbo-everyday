"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { getTeamBySlug, getTeamBgColor } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";
import PhotoFeed from "@/components/community/PhotoFeed";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import WritePoll from "@/components/community/WritePoll";
import WriteEntrySheet from "@/components/community/WriteEntrySheet";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";
import { useUnifiedFeed } from "@/lib/supabase/useUnifiedFeed";
import { useFeedScrollRestore } from "@/lib/community/useFeedScrollRestore";

export default function CommunityTeamBoardPage() {
  const params = useParams();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);

  const router = useRouter();
  const [showEntry, setShowEntry] = useState(false);
  const [showPoll, setShowPoll] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const { user } = useAuth();

  // 글·사진 한 스트림 통합 피드 (전체글/팀/선수 동일 컴포넌트 공유).
  // 복원은 이 라우트 경로로 되돌아온 뒤로가기에서만 발동한다(restorePath).
  const feedPath = `/community/teams/${teamSlug}`;
  const {
    posts, likedIds, loading, loadingMore, hasMore, loadMore, setPostLiked, reload,
    feedKey, pageCountRef, pendingScrollY, consumePendingScroll,
  } = useUnifiedFeed({ kind: "team", teamId: teamSlug }, 20, { restorePath: feedPath });

  // 글 상세 진입 후 뒤로가기로 돌아오면 보던 위치·분량 복원(#cs 제보).
  useFeedScrollRestore({ feedKey, feedPath, pageCountRef, loading, pendingScrollY, consumePendingScroll });

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
        onClick={() => (user ? setShowEntry(true) : setShowLogin(true))}
        className="fixed bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
      >
        <Pencil size={24} />
      </button>

      {/* ⑦ 글쓰기 진입: 사진글/일반글 타입 선택 먼저 */}
      <WriteEntrySheet
        isOpen={showEntry}
        onClose={() => setShowEntry(false)}
        onChoosePhoto={() => { setShowEntry(false); setShowPhoto(true); }}
        onChooseText={() => { setShowEntry(false); setWriteOpen(true); }}
        onChoosePoll={() => { setShowEntry(false); setShowPoll(true); }}
      />

      <WritePoll
        isOpen={showPoll}
        onClose={() => setShowPoll(false)}
        onCreated={(postId) => { setShowPoll(false); router.push(`/community/free/${postId}`); }}
      />

      {/* Write post modal (글·사진 첨부 통합 — 밈 에디터/태그는 S5 통합 컴포저로 이관 예정) */}
      <WritePost
        isOpen={writeOpen}
        onClose={() => setWriteOpen(false)}
        teamName={team.name}
        enableTags
        defaultTeamSlugs={[teamSlug]}
        onSubmit={async (title, content, imageUrls, _seatInfo, tags) => {
          await createPost({
            boardType: "team",
            boardId: teamSlug,
            title,
            content,
            imageUrls,
            contentType: "general",
            // V3 태그 모델: 팀 게시판 글은 해당 팀 태그를 자동 부여해야
            // team_tags 기준 팀 피드(ad1987be)에 노출됨. 누락 시 자기 팀 탭에서 사라짐.
            // 피커로 추가/변경한 태그가 있으면 그걸 우선(기본값=해당 팀).
            teamTags: tags?.teamTags?.length ? tags.teamTags : [teamSlug],
            playerTags: tags?.playerTags,
          });
          reload();
          setWriteOpen(false);
        }}
      />

      <WritePhotoPost
        isOpen={showPhoto}
        onClose={() => setShowPhoto(false)}
        teamName={team.name}
        boardType="team"
        boardId={teamSlug}
        defaultTeamSlugs={[teamSlug]}
        onSuccess={() => { setShowPhoto(false); reload(); }}
      />

      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
