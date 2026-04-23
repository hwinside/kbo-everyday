"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";
import { useUnifiedPosts } from "@/lib/supabase/useUnifiedPosts";
import WritePost from "@/components/community/WritePost";
import UnifiedFeed from "@/components/community/UnifiedFeed";

export default function FreeBoardPage() {
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const { posts, loading, reload } = useUnifiedPosts("free", "general");

  const handleLike = async (postId: number) => {
    try { await toggleLike(postId); } catch { /* ignore */ }
  };

  function handleWrite() {
    if (!user) {
      setShowLogin(true);
      return;
    }
    setShowWrite(true);
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="h-3" />

      {/* Unified feed */}
      <div className="py-3">
        <UnifiedFeed
          posts={posts}
          loading={loading}
          onLike={handleLike}
          boardContext={{ type: "free" }}
        />
      </div>

      {/* FAB — free board only has text posts */}
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
