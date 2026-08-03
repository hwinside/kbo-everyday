"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { usePosts, createPost } from "@/lib/supabase/usePosts";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import WritePoll from "@/components/community/WritePoll";
import WriteEntrySheet from "@/components/community/WriteEntrySheet";
import PostList from "@/components/community/PostList";
import type { Post } from "@/lib/types";

export default function FreeBoardPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [showLogin, setShowLogin] = useState(false);
  const [showEntry, setShowEntry] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  const [showPoll, setShowPoll] = useState(false);
  const { posts: rawPosts, loading, reload } = usePosts("free", "general");
  // 자유게시판에도 투표글(board_type='poll')을 함께 노출 — 자유게시판 FAB의 '투표'로
  // 작성한 글을 같은 목록에서 볼 수 있게(PostList가 poll 배치 요약→전용 카드 렌더).
  const { posts: pollRaw } = usePosts("poll", "poll");

  // Transform to shared Post type (same pattern as team/player boards)
  const toPost = (p: (typeof rawPosts)[number], boardType: "free" | "poll"): Post => ({
    id: p.id,
    boardType,
    boardId: boardType === "poll" ? "poll" : "general",
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
      avatarUrl: p.avatar_url ?? null,
      myTeamId: p.team_id || null,
      level: 1,
      title: "",
      grade: p.grade,
    },
  });
  // 자유글 + 투표글을 작성순(created_at DESC)로 병합.
  const posts: Post[] = [
    ...rawPosts.map((p) => toPost(p, "free")),
    ...pollRaw.map((p) => toPost(p, "poll")),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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
    </div>
  );
}
