"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Pencil } from "lucide-react";
import PhotoFeed from "@/components/community/PhotoFeed";
import PostSearchBar from "@/components/community/PostSearchBar";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import WritePoll from "@/components/community/WritePoll";
import WriteEntrySheet from "@/components/community/WriteEntrySheet";
import LoginSheet from "@/components/auth/LoginSheet";
import { normalizeSearchQuery, SEARCH_MIN_LEN, useUnifiedFeed } from "@/lib/supabase/useUnifiedFeed";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";
import { useFeedScrollRestore } from "@/lib/community/useFeedScrollRestore";

function AllPostsPageContent() {
  // 복원은 이 라우트 경로로 되돌아온 뒤로가기에서만 발동한다(restorePath).
  const feedPath = "/community/all-posts";

  // 검색어(커뮤니티 검색 v1). `?q=` 가 SSOT — 뒤로가기·공유·새로고침에서 그대로 살아난다.
  // 첫 렌더부터 URL 의 q 로 피드 키를 정해야 한다: 키가 "all" 로 시작한 뒤 "all:q=…" 로 바뀌면
  // 1회용 뒤로가기 플래그를 "all" 이 먼저 소비해 검색 결과 복원이 끊긴다. (useSearchParams → Suspense 경계)
  const searchParams = useSearchParams();
  const [rawQ, setRawQ] = useState(() => searchParams.get("q") ?? "");
  const q = normalizeSearchQuery(rawQ);

  const {
    posts, likedIds, loading, loadingMore, hasMore, loadMore, setPostLiked, reload,
    feedKey, pageCountRef, pendingScrollY, consumePendingScroll,
  } = useUnifiedFeed({ kind: "all", q }, 20, { restorePath: feedPath });

  // 글 상세 진입 후 뒤로가기로 돌아오면 보던 위치·분량 복원(#cs 제보).
  // feedKey 에 검색어가 포함돼 있어 검색 결과 화면도 검색어별로 같은 복원을 탄다(삼순 리뷰 정정 ①).
  useFeedScrollRestore({ feedKey, feedPath, pageCountRef, loading, pendingScrollY, consumePendingScroll });
  const { user, loading: authLoading } = useAuth();

  // 검색어 확정(디바운스 후) → 상태 + URL 동기화. 라우터 push 를 쓰지 않는 이유: 히스토리를 검색어마다
  // 쌓으면 뒤로가기가 상세가 아니라 이전 검색어로 간다. `?write=1` 처리와 같은 replaceState 경로.
  const handleSearchCommit = useCallback((raw: string) => {
    setRawQ(raw);
    const url = new URL(window.location.href);
    const trimmed = raw.trim();
    if (trimmed) url.searchParams.set("q", trimmed);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url.pathname + url.search);
  }, []);

  // 검색어가 실제로 바뀌면(유저 조작) 최상단으로. 마운트 시점(뒤로가기 복원 포함)에는 건드리지 않는다.
  const prevQRef = useRef(q);
  useEffect(() => {
    if (prevQRef.current === q) return;
    prevQRef.current = q;
    window.scrollTo(0, 0);
  }, [q]);

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
        <div className="mt-3">
          <PostSearchBar initialValue={rawQ} onCommit={handleSearchCommit} />
        </div>
        {q === null && rawQ.trim().length > 0 && (
          <p className="mt-2 text-xs text-text-tertiary" data-testid="post-search-hint">
            {SEARCH_MIN_LEN}자 이상 입력하면 검색됩니다.
          </p>
        )}
      </div>

      {q !== null && !loading && posts.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-20 text-text-tertiary"
          data-testid="post-search-empty"
        >
          <p className="text-base">‘{q}’ 검색 결과가 없어요.</p>
          <p className="mt-1 text-sm">다른 검색어로 다시 찾아보세요.</p>
        </div>
      ) : (
        <PhotoFeed posts={posts} loading={loading} onLike={handleLike} likedIds={likedIds} />
      )}

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

/** useSearchParams 는 Suspense 경계가 필요하다(players 페이지와 같은 패턴). */
export default function AllPostsPage() {
  return (
    <Suspense
      fallback={<div className="mx-auto max-w-lg px-5 py-10 text-center text-text-tertiary">로딩중...</div>}
    >
      <AllPostsPageContent />
    </Suspense>
  );
}
