"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { MessageCircle } from "lucide-react";
import { GRADES } from "@/lib/constants/grades";
import type { Post } from "@/lib/supabase/usePosts";

interface PhotoFeedProps {
  posts: Post[];
  loading: boolean;
  onLike: (postId: number) => void;
  onPostClick: (postId: number) => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  return new Date(dateStr).toLocaleDateString("ko-KR");
}

function getGradeInfo(gradeId?: string) {
  return GRADES.find((g) => g.id === gradeId) ?? GRADES[0];
}

function PhotoCarousel({ images }: { images: string[] }) {
  const [current, setCurrent] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);
  const touchDeltaX = useRef(0);
  const [translateX, setTranslateX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchDeltaX.current = 0;
    setIsSwiping(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const delta = e.touches[0].clientX - touchStartX.current;
    touchDeltaX.current = delta;
    setTranslateX(delta);
  }, []);

  const handleTouchEnd = useCallback(() => {
    setIsSwiping(false);
    const threshold = 50;
    if (touchDeltaX.current < -threshold && current < images.length - 1) {
      setCurrent((prev) => prev + 1);
    } else if (touchDeltaX.current > threshold && current > 0) {
      setCurrent((prev) => prev - 1);
    }
    setTranslateX(0);
  }, [current, images.length]);

  if (images.length === 1) {
    return (
      <div className="relative w-full overflow-hidden rounded-xl bg-bg-tertiary">
        <Image
          src={images[0]}
          alt="photo"
          width={600}
          height={600}
          className="w-full h-auto object-cover"
          style={{ maxHeight: "500px" }}
        />
      </div>
    );
  }

  return (
    <div className="relative w-full overflow-hidden rounded-xl bg-bg-tertiary">
      <div
        ref={containerRef}
        className="flex"
        style={{
          transform: `translateX(calc(-${current * 100}% + ${isSwiping ? translateX : 0}px))`,
          transition: isSwiping ? "none" : "transform 0.3s ease-out",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {images.map((url, i) => (
          <div key={i} className="w-full flex-shrink-0">
            <Image
              src={url}
              alt={`photo ${i + 1}`}
              width={600}
              height={600}
              className="w-full h-auto object-cover"
              style={{ maxHeight: "500px" }}
            />
          </div>
        ))}
      </div>
      {/* Dot indicators */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
        {images.map((_, i) => (
          <div
            key={i}
            className={`w-1.5 h-1.5 rounded-full transition-colors ${
              i === current ? "bg-white" : "bg-white/40"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

export default function PhotoFeed({ posts, loading, onLike, onPostClick }: PhotoFeedProps) {
  const [likedPosts, setLikedPosts] = useState<Set<number>>(new Set());

  const handleLike = (postId: number) => {
    setLikedPosts((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
    onLike(postId);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="rounded-2xl bg-bg-secondary p-4 animate-pulse">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-bg-tertiary" />
              <div className="h-4 bg-bg-tertiary rounded w-24" />
            </div>
            <div className="w-full aspect-square rounded-xl bg-bg-tertiary" />
          </div>
        ))}
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
        <p className="text-base">아직 사진이 없어요.</p>
        <p className="mt-1 text-sm">첫 번째 사진을 올려보세요!</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {posts.map((post) => {
        const grade = getGradeInfo(post.grade);
        const isLiked = likedPosts.has(post.id);

        return (
          <div key={post.id} className="rounded-2xl bg-bg-secondary overflow-hidden">
            {/* Author header */}
            <div className="flex items-center gap-2.5 px-4 py-3">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm"
                style={{ backgroundColor: grade.bgColor }}
              >
                {grade.emoji}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-text-primary truncate">
                    {post.nickname || "익명"}
                  </span>
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                    style={{ color: grade.color, backgroundColor: grade.bgColor }}
                  >
                    {grade.name}
                  </span>
                </div>
              </div>
              <span className="text-xs text-text-tertiary flex-shrink-0">
                {timeAgo(post.created_at)}
              </span>
            </div>

            {/* Photo carousel */}
            {post.image_urls.length > 0 && (
              <div className="px-3">
                <PhotoCarousel images={post.image_urls} />
              </div>
            )}

            {/* Action bar */}
            <div className="flex items-center gap-4 px-4 py-2.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleLike(post.id);
                }}
                className="flex items-center gap-1 text-sm transition-colors"
              >
                <span className="text-lg">{isLiked ? "\u2764\uFE0F" : "\u2661"}</span>
                <span className={isLiked ? "text-red-500 font-medium" : "text-text-secondary"}>
                  {post.like_count + (isLiked ? 1 : 0)}
                </span>
              </button>
              <button
                onClick={() => onPostClick(post.id)}
                className="flex items-center gap-1 text-sm text-text-secondary"
              >
                <MessageCircle size={18} />
                <span>{post.comment_count}</span>
              </button>
            </div>

            {/* Caption */}
            {post.content && (
              <div className="px-4 pb-3">
                <button
                  onClick={() => onPostClick(post.id)}
                  className="text-left"
                >
                  <span className="text-sm font-semibold text-text-primary mr-1.5">
                    {post.nickname || "익명"}
                  </span>
                  <span className="text-sm text-text-secondary">{post.content}</span>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
