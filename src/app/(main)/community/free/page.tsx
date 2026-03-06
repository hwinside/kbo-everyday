"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Heart, MessageCircle, Pencil } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { usePosts, createPost } from "@/lib/supabase/usePosts";
import WritePost from "@/components/community/WritePost";

export default function FreeBoardPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const { posts, loading, reload } = usePosts('free', 'general');

  function handleWrite() {
    if (!user) {
      setShowLogin(true);
      return;
    }
    setShowWrite(true);
  }

  function formatTimeAgo(dateString: string) {
    const now = new Date();
    const postTime = new Date(dateString);
    const diffMs = now.getTime() - postTime.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMinutes < 60) {
      return `${diffMinutes}분 전`;
    } else if (diffHours < 24) {
      return `${diffHours}시간 전`;
    } else {
      return `${diffDays}일 전`;
    }
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-4 pb-5">
        <button
          onClick={() => router.back()}
          className="rounded-full p-1.5 text-text-secondary hover:bg-bg-tertiary transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-3xl font-extrabold tracking-tight text-text-primary">
          자유게시판
        </h1>
      </div>

      {/* Posts */}
      <div className="mx-5 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-text-tertiary">
            <p>로딩 중...</p>
          </div>
        ) : posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
            <p className="text-sm">아직 게시글이 없어요</p>
            <p className="text-xs mt-1">첫 번째 글을 작성해보세요!</p>
          </div>
        ) : (
          posts.map((post) => (
            <GlassCard key={post.id} pressable className="p-4" onClick={() => router.push(`/community/free/${post.id}`)}>
              <h3 className="text-sm font-semibold text-text-primary">{post.title}</h3>
              <div className="mt-2 flex items-center gap-4 text-xs text-text-tertiary">
                <div className="flex items-center">
                  <span>{post.nickname || "익명"}</span>
                  {post.grade === 'staff' && (
                    <span className='ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-accent/20 text-accent rounded-full'>운영팀</span>
                  )}
                </div>
                <span>{formatTimeAgo(post.created_at)}</span>
                <span className="flex items-center gap-1">
                  <Heart size={12} /> {post.like_count}
                </span>
                <span className="flex items-center gap-1">
                  <MessageCircle size={12} /> {post.comment_count}
                </span>
              </div>
            </GlassCard>
          ))
        )}
      </div>

      {/* FAB */}
      <button
        onClick={handleWrite}
        className="fixed bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
      >
        <Pencil size={24} />
      </button>

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      <WritePost
        isOpen={showWrite}
        onClose={() => setShowWrite(false)}
        teamName="자유게시판"
        onSubmit={async (title, content, imageUrls) => {
          await createPost({ boardType: "free", boardId: "general", title, content, imageUrls });
          reload();
          setShowWrite(false);
        }}
      />
    </div>
  );
}
