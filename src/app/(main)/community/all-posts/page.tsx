"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import PhotoFeed from "@/components/community/PhotoFeed";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import WritePoll from "@/components/community/WritePoll";
import WriteEntrySheet from "@/components/community/WriteEntrySheet";
import LoginSheet from "@/components/auth/LoginSheet";
import { useUnifiedFeed } from "@/lib/supabase/useUnifiedFeed";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getCommunitySourceLabel, type CommunitySourceLabel } from "@/lib/utils/community-board";
import { useFeedScrollRestore } from "@/lib/community/useFeedScrollRestore";

export default function AllPostsPage() {
  // 복원은 이 라우트 경로로 되돌아온 뒤로가기에서만 발동한다(restorePath).
  const feedPath = "/community/all-posts";
  const {
    posts, likedIds, loading, loadingMore, hasMore, loadMore, setPostLiked, reload,
    feedKey, pageCountRef, pendingScrollY, consumePendingScroll,
  } = useUnifiedFeed({ kind: "all" }, 20, { restorePath: feedPath });

  // 글 상세 진입 후 뒤로가기로 돌아오면 보던 위치·분량 복원(#cs 제보).
  useFeedScrollRestore({ feedKey, feedPath, pageCountRef, loading, pendingScrollY, consumePendingScroll });
  const { user, loading: authLoading } = useAuth();

  const router = useRouter();
  const [showLogin, setShowLogin] = useState(false);
  const [showEntry, setShowEntry] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const [showPoll, setShowPoll] = useState(false);

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

  const sourceLabels = useMemo<Record<number, CommunitySourceLabel>>(
    () => Object.fromEntries(posts.map((p) => [p.id, getCommunitySourceLabel(p.board_type, p.board_id)])),
    [posts],
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

  // 홈 '새 글 올리기' CTA(?write=1) 진입 시 글쓰기 시트 자동 오픈(FAB 탭과 동일 분기).
  // 인증 확정 후 1회만 실행하고, 쿼리는 정리해 뒤로가기/새로고침 재오픈을 막는다.
  const writeTriggered = useRef(false);
  useEffect(() => {
    if (authLoading || writeTriggered.current) return;
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("write") !== "1") return;
    writeTriggered.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("write");
    window.history.replaceState(null, "", url.pathname + url.search);
    // 다음 틱에 시트 오픈 — 이펙트 내 동기 setState(cascading render) 회피.
    setTimeout(() => (user ? setShowEntry(true) : setShowLogin(true)), 0);
  }, [authLoading, user]);

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="px-5 pt-4 pb-3">
        <p className="text-sm text-text-tertiary">팀, 선수, 자유게시판 글을 한 번에 봅니다.</p>
      </div>

      <PhotoFeed posts={posts} loading={loading} onLike={handleLike} likedIds={likedIds} sourceLabels={sourceLabels} />

      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-6 text-sm text-text-tertiary">
          {loadingMore ? "불러오는 중…" : ""}
        </div>
      )}

      {/* FAB — 전체글 탭에서도 글쓰기 진입 (작성 글은 자유게시판 + 선택 태그) */}
      <button
        onClick={() => (user ? setShowEntry(true) : setShowLogin(true))}
        className="fixed bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
      >
        <Pencil size={24} />
      </button>

      <WriteEntrySheet
        isOpen={showEntry}
        onClose={() => setShowEntry(false)}
        onChoosePhoto={() => { setShowEntry(false); setShowPhoto(true); }}
        onChooseText={() => { setShowEntry(false); setShowWrite(true); }}
        onChoosePoll={() => { setShowEntry(false); setShowPoll(true); }}
      />
      <WritePost
        isOpen={showWrite}
        onClose={() => setShowWrite(false)}
        teamName="자유게시판"
        enableTags
        onSubmit={async (title, content, imageUrls, _seatInfo, tags) => {
          await createPost({
            boardType: "free",
            boardId: "general",
            title,
            content,
            imageUrls,
            teamTags: tags?.teamTags,
            playerTags: tags?.playerTags,
          });
          reload();
          setShowWrite(false);
        }}
      />
      <WritePhotoPost
        isOpen={showPhoto}
        onClose={() => setShowPhoto(false)}
        teamName="자유게시판"
        boardType="free"
        boardId="general"
        onSuccess={() => { setShowPhoto(false); reload(); }}
      />
      <WritePoll
        isOpen={showPoll}
        onClose={() => setShowPoll(false)}
        onCreated={(postId) => { setShowPoll(false); router.push(`/community/free/${postId}`); }}
      />
      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
