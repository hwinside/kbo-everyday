"use client";

import { useState } from "react";
import { Pencil, X, Camera, FileText } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";
import { useUnifiedPosts } from "@/lib/supabase/useUnifiedPosts";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import UnifiedFeed from "@/components/community/UnifiedFeed";

export default function FreeBoardPage() {
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const [showPhotoWrite, setShowPhotoWrite] = useState(false);
  const [fabExpanded, setFabExpanded] = useState(false);
  const { posts, loading, reload } = useUnifiedPosts("free", "general");

  const handleLike = async (postId: number) => {
    try { await toggleLike(postId); } catch { /* ignore */ }
  };

  const handleFabClick = () => {
    if (!user) { setShowLogin(true); return; }
    setFabExpanded(prev => !prev);
  };

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

      {/* FAB with write type selection */}
      <div className="fixed bottom-24 right-5 z-40 flex flex-col-reverse items-center gap-3">
        <AnimatePresence>
          {fabExpanded && (
            <>
              <button
                onClick={() => { setFabExpanded(false); setShowWrite(true); }}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-tertiary text-text-primary shadow-lg transition-transform hover:scale-105 active:scale-95"
              >
                <FileText size={20} />
              </button>
              <button
                onClick={() => { setFabExpanded(false); setShowPhotoWrite(true); }}
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
      <WritePhotoPost
        isOpen={showPhotoWrite}
        onClose={() => setShowPhotoWrite(false)}
        teamName="자유게시판"
        boardType="free"
        boardId="general"
        onSuccess={() => reload()}
      />
    </div>
  );
}
