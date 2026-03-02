"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ChevronLeft, Heart, MessageCircle, Share2, Send } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";

import { usePostDetail, createComment, toggleLike } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";

export default function PostDetailPage() {
  const { playerId, postId } = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const { post, comments, loading, liked, setLiked, setComments } = usePostDetail(Number(postId));
  const [comment, setComment] = useState("");
  const [likeCount, setLikeCount] = useState(0);

  if (loading) return <div className="flex items-center justify-center h-screen text-text-secondary">로딩 중...</div>;
  if (!post) return <div className="flex items-center justify-center h-screen text-text-secondary">게시글을 찾을 수 없습니다</div>;

  const team = post.team_id ? getTeamById(post.team_id) : null;
  const teamColor = team?.colorPrimary ?? "#666";

  async function handleLike() {
    if (!user) { alert("로그인이 필요합니다"); return; }
    try {
      const newLiked = await toggleLike(post!.id);
      setLiked(newLiked);
      setLikeCount(prev => newLiked ? prev + 1 : prev - 1);
    } catch {}
  }

  async function handleComment() {
    if (!user) { alert("로그인이 필요합니다"); return; }
    if (!comment.trim()) return;
    try {
      await createComment(post!.id, comment.trim());
      setComment("");
      // 댓글 즉시 추가 (optimistic)
      setComments(prev => [...prev, {
        id: Date.now(),
        post_id: post!.id,
        author_id: user.id,
        content: comment.trim(),
        created_at: new Date().toISOString(),
        nickname: "나",
        team_id: undefined,
        grade: undefined,
      }]);
    } catch {}
  }

  const timeAgo = (date: string) => {
    const diff = Date.now() - new Date(date).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return "방금 전";
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    return `${Math.floor(hr / 24)}일 전`;
  };

  return (
    <div className="min-h-screen bg-bg-primary pb-20">
      {/* Header */}
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary/80 backdrop-blur-xl">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => router.back()}>
            <ChevronLeft size={24} className="text-text-secondary" />
          </button>
          <span className="text-base font-semibold text-text-primary flex-1">게시글</span>
          <button onClick={async () => {
            if (navigator.share) await navigator.share({ title: post.title, url: window.location.href });
            else { await navigator.clipboard.writeText(window.location.href); alert("링크 복사됨!"); }
          }}>
            <Share2 size={20} className="text-text-tertiary" />
          </button>
        </div>
      </div>

      {/* Post */}
      <div className="px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          {team && <TeamBadge teamId={team.id} size="xs" />}
          <span className="text-sm font-semibold text-text-primary">{post.nickname || "익명"}</span>
          <span className="text-xs text-text-tertiary ml-auto">{timeAgo(post.created_at)}</span>
        </div>

        <h1 className="text-lg font-bold text-text-primary mb-3">{post.title}</h1>
        <p className="text-sm text-text-secondary whitespace-pre-line leading-relaxed">{post.content}</p>

        {/* Images */}
        {post.image_urls.length > 0 && (
          <div className="mt-4 space-y-2">
            {post.image_urls.map((url, i) => (
              <img key={i} src={url} alt="" className="rounded-xl w-full" />
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-6 mt-4 pt-3 border-t border-border">
          <button onClick={handleLike} className="flex items-center gap-1.5">
            <Heart size={20} className={liked ? "text-red-500" : "text-text-tertiary"} fill={liked ? "currentColor" : "none"} />
            <span className="text-sm text-text-secondary">{post.like_count + likeCount}</span>
          </button>
          <div className="flex items-center gap-1.5">
            <MessageCircle size={20} className="text-text-tertiary" />
            <span className="text-sm text-text-secondary">{comments.length}</span>
          </div>
        </div>
      </div>

      {/* Comments */}
      <div className="border-t border-border">
        <div className="px-5 py-3">
          <h3 className="text-sm font-bold text-text-primary">댓글 {comments.length}개</h3>
        </div>
        <div className="px-5 space-y-4 pb-4">
          {comments.map(c => (
            <div key={c.id}>
              <div className="flex items-center gap-2 mb-1">
                {c.team_id && <TeamBadge teamId={c.team_id} size="xs" />}
                <span className="text-sm font-semibold text-text-primary">{c.nickname || "익명"}</span>
                <span className="text-xs text-text-tertiary">{timeAgo(c.created_at)}</span>
              </div>
              <p className="text-sm text-text-secondary">{c.content}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Comment Input */}
      <div className="fixed bottom-16 left-0 right-0 bg-bg-primary border-t border-border px-4 py-3 flex items-center gap-3 z-40">
        <input
          type="text"
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder={user ? "댓글을 입력하세요" : "로그인 후 댓글 작성 가능"}
          disabled={!user}
          className="flex-1 bg-bg-tertiary rounded-xl px-4 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
          onKeyDown={e => e.key === "Enter" && handleComment()}
        />
        <button onClick={handleComment} disabled={!comment.trim() || !user} className="text-accent disabled:opacity-30">
          <Send size={20} />
        </button>
      </div>
    </div>
  );
}
