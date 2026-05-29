"use client";

import { useEffect, useMemo, useRef } from "react";
import PhotoFeed from "@/components/community/PhotoFeed";
import { useUnifiedFeed } from "@/lib/supabase/useUnifiedFeed";
import { toggleLike } from "@/lib/supabase/usePosts";
import { getCommunitySourceLabel, type CommunitySourceLabel } from "@/lib/utils/community-board";

export default function AllPostsPage() {
  const { posts, loading, loadingMore, hasMore, loadMore } = useUnifiedFeed({ kind: "all" });

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

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="px-5 pt-4 pb-3">
        <p className="text-sm text-text-tertiary">팀, 선수, 자유게시판 글을 한 번에 봅니다.</p>
      </div>

      <PhotoFeed posts={posts} loading={loading} onLike={toggleLike} sourceLabels={sourceLabels} />

      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-6 text-sm text-text-tertiary">
          {loadingMore ? "불러오는 중…" : ""}
        </div>
      )}
    </div>
  );
}
