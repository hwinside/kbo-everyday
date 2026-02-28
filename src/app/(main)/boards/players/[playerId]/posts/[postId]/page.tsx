"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ChevronLeft, Heart, MessageCircle, Share2, MoreHorizontal, Send } from "lucide-react";
import Image from "next/image";
import { getTeamColor, getTeamName } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";

const MOCK_POST = {
  id: "post-1",
  title: "박동원 오늘 경기 리뷰",
  content: `오늘 박동원 진짜 대박이었습니다.

5회말 투아웃 만루 상황에서 좌중간 2루타로 역전 3타점!
시즌 타율도 .312로 올렸고, 특히 득점권 타율이 .380이라는 게 진짜 클러치 그 자체.

수비에서도 2번이나 도루 저지 성공했고, 투수 리드도 완벽했어요.
오늘 같은 경기를 보면 왜 팬들이 박동원을 사랑하는지 알 수 있죠.

내일 경기도 기대됩니다! 🔥`,
  author: "야구광팬",
  authorLevel: 15,
  authorBadgeColor: "#FFD700",
  teamId: 1,
  timeAgo: "방금 전",
  likes: 26,
  comments: [
    { id: "c1", author: "LG사랑", level: 8, badgeColor: "#4A90D9", teamId: 1, content: "오늘 진짜 소름돋았어요 ㄷㄷ", timeAgo: "5분 전", likes: 12 },
    { id: "c2", author: "직관러", level: 12, badgeColor: "#FF6B6B", teamId: 1, content: "잠실에서 직관했는데 만루 때 소리가 미쳤음", timeAgo: "12분 전", likes: 8 },
    { id: "c3", author: "통계매니아", level: 22, badgeColor: "#FF4444", teamId: 1, content: "득점권 타율 .380은 역대급인데 이 페이스 유지되면 올스타 확정", timeAgo: "30분 전", likes: 15 },
    { id: "c4", author: "트윈스4ever", level: 5, badgeColor: "#8BC34A", teamId: 1, content: "수비도 진짜 좋았음 도루저지 2개 ㄹㅇ", timeAgo: "45분 전", likes: 4 },
    { id: "c5", author: "KBO덕후", level: 18, badgeColor: "#9C27B0", teamId: 1, content: "내일도 이렇게만 해줘 🙏", timeAgo: "1시간 전", likes: 6 },
  ],
  images: [] as string[],
};

export default function PostDetailPage() {
  const { playerId, postId } = useParams();
  const router = useRouter();
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(MOCK_POST.likes);
  const [comment, setComment] = useState("");
  const [comments, setComments] = useState(MOCK_POST.comments);

  const post = MOCK_POST;
  const teamColor = getTeamColor(post.teamId);

  function handleLike() {
    setLiked(!liked);
    setLikeCount((prev) => (liked ? prev - 1 : prev + 1));
  }

  function handleComment() {
    if (!comment.trim()) return;
    setComments((prev) => [
      { id: `c-new-${Date.now()}`, author: "나", level: 1, badgeColor: "#4FC3F7", teamId: 1, content: comment, timeAgo: "방금 전", likes: 0 },
      ...prev,
    ]);
    setComment("");
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-32">
      {/* Header */}
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary/80 backdrop-blur-xl">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => router.back()} className="text-text-secondary p-1">
            <ChevronLeft size={24} />
          </button>
          <span className="text-lg font-semibold text-text-primary flex-1">게시글</span>
          <button className="text-text-secondary p-1">
            <MoreHorizontal size={22} />
          </button>
        </div>
      </div>

      {/* Post content */}
      <div className="px-5 py-5">
        {/* Author info */}
        <div className="flex items-center gap-3 mb-4">
          <TeamBadge teamId={post.teamId} />
          <span className="text-base font-semibold text-text-primary">{post.author}</span>
          <span className="flex items-center gap-1 text-sm">
            <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: post.authorBadgeColor }} />
            Lv.{post.authorLevel}
          </span>
          <span className="text-sm text-text-tertiary ml-auto">{post.timeAgo}</span>
        </div>

        {/* Title */}
        <h1 className="text-xl font-bold text-text-primary mb-3">{post.title}</h1>

        {/* Content */}
        <p className="text-base text-text-secondary leading-relaxed whitespace-pre-line">{post.content}</p>

        {/* Action bar */}
        <div className="flex items-center gap-6 mt-6 pt-4 border-t border-border">
          <button onClick={handleLike} className="flex items-center gap-2 transition-colors">
            <Heart size={22} className={liked ? "fill-red-500 text-red-500" : "text-text-tertiary"} />
            <span className={`text-base font-medium ${liked ? "text-red-500" : "text-text-tertiary"}`}>{likeCount}</span>
          </button>
          <div className="flex items-center gap-2 text-text-tertiary">
            <MessageCircle size={22} />
            <span className="text-base font-medium">{comments.length}</span>
          </div>
          <button className="flex items-center gap-2 text-text-tertiary ml-auto">
            <Share2 size={22} />
          </button>
        </div>
      </div>

      {/* Comments section */}
      <div className="border-t border-border">
        <div className="px-5 py-4">
          <h3 className="text-base font-semibold text-text-primary mb-4">댓글 {comments.length}</h3>
          <div className="space-y-5">
            {comments.map((c) => (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex gap-3"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold" style={{ backgroundColor: teamColor }}>
                  {c.author[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-text-primary">{c.author}</span>
                    <span className="flex items-center gap-1 text-xs text-text-tertiary">
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: c.badgeColor }} />
                      Lv.{c.level}
                    </span>
                    <span className="text-xs text-text-tertiary ml-auto">{c.timeAgo}</span>
                  </div>
                  <p className="text-base text-text-secondary">{c.content}</p>
                  <button className="flex items-center gap-1 mt-1.5 text-text-tertiary">
                    <Heart size={14} />
                    <span className="text-xs">{c.likes}</span>
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* Fixed comment input */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-bg-secondary px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="댓글을 입력하세요"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleComment()}
            className="flex-1 rounded-full bg-bg-tertiary px-4 py-2.5 text-base text-text-primary placeholder:text-text-tertiary outline-none"
          />
          <button
            onClick={handleComment}
            disabled={!comment.trim()}
            className="flex-shrink-0 w-10 h-10 rounded-full bg-accent flex items-center justify-center disabled:opacity-40 transition-opacity"
          >
            <Send size={18} className="text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}
