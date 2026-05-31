"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { usePosts, createPost } from "@/lib/supabase/usePosts";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import WriteEntrySheet from "@/components/community/WriteEntrySheet";
import PostList from "@/components/community/PostList";
import type { Post } from "@/lib/types";
import { getMyTeamId } from "@/lib/store/myteam";
import { getTeamById } from "@/lib/constants/teams";

export default function FreeBoardPage() {
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showEntry, setShowEntry] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const { posts: rawPosts, loading, reload } = usePosts("free", "general");

  const myTeamSlugs = (() => {
    const slug = getTeamById(getMyTeamId() ?? -1)?.slug;
    return slug ? [slug] : [];
  })();

  // Transform to shared Post type (same pattern as team/player boards)
  const posts: Post[] = rawPosts.map((p) => ({
    id: p.id,
    boardType: "free" as const,
    boardId: "general",
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
      myTeamId: p.team_id || null,
      level: 1,
      title: "",
      grade: p.grade,
    },
  }));

  function handleWrite() {
    if (!user) {
      setShowLogin(true);
      return;
    }
    setShowEntry(true);
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="h-3" />

      {/* Posts */}
      <div className="mx-5">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-text-tertiary">
            <p>로딩 중...</p>
          </div>
        ) : (
          <PostList posts={posts} />
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
      <WriteEntrySheet
        isOpen={showEntry}
        onClose={() => setShowEntry(false)}
        onChoosePhoto={() => { setShowEntry(false); setShowPhoto(true); }}
        onChooseText={() => { setShowEntry(false); setShowWrite(true); }}
      />
      <WritePost
        isOpen={showWrite}
        onClose={() => setShowWrite(false)}
        teamName="자유게시판"
        enableTags
        defaultTeamSlugs={myTeamSlugs}
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
        defaultTeamSlugs={myTeamSlugs}
        onSuccess={() => { setShowPhoto(false); reload(); }}
      />
    </div>
  );
}
