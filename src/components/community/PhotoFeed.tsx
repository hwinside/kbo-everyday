"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { MessageCircle, Play } from "lucide-react";
import { GRADES } from "@/lib/constants/grades";
import { getTeamById } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { parsePlayerTag } from "@/lib/utils/player-tags";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import type { Post } from "@/lib/supabase/usePosts";
import CommentSheet from "./CommentSheet";

function findPlayerByName(name: string): { kboId: string; teamId: number } | null {
  for (const p of PLAYERS_ROSTER) {
    if (p.name === name) return { kboId: p.kboId, teamId: p.teamId };
  }
  return null;
}

function findPlayerByKboId(kboId: string): { teamId: number } | null {
  for (const p of PLAYERS_ROSTER) {
    if (p.kboId === kboId) return { teamId: p.teamId };
  }
  return null;
}

interface PhotoFeedProps {
  posts: Post[];
  loading: boolean;
  onLike: (postId: number) => void;
  boardType?: "team" | "player";
  /** 선수 게시판: post별 playerLabel 맵 (postId → {teamId, playerName}) */
  playerLabels?: Record<number, { teamId: number; playerName: string }>;
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

interface MediaSlide {
  url: string;
  isVideo: boolean;
}

function MediaElement({ url, isVideo, sizes }: { url: string; isVideo: boolean; sizes?: string }) {
  const isGif = !isVideo && url.toLowerCase().endsWith(".gif");

  if (isVideo) {
    return (
      <video
        src={url}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        className="w-full object-contain pointer-events-none select-none bg-black"
        style={{ maxHeight: "80vh", WebkitTouchCallout: "none" } as React.CSSProperties}
      />
    );
  }

  if (isGif) {
    return (
      <Image
        src={url}
        alt="gif"
        width={800}
        height={600}
        unoptimized
        className="w-full object-contain pointer-events-none select-none bg-black"
        draggable={false}
        style={{ maxHeight: "80vh", WebkitTouchCallout: "none" } as React.CSSProperties}
        sizes={sizes ?? "(max-width: 768px) 100vw, 600px"}
      />
    );
  }

  return (
    <Image
      src={url}
      alt="photo"
      width={800}
      height={1000}
      className="w-full object-cover pointer-events-none select-none"
      draggable={false}
      style={{ aspectRatio: "4/5", WebkitTouchCallout: "none" } as React.CSSProperties}
      sizes={sizes ?? "(max-width: 768px) 100vw, 600px"}
    />
  );
}

function PhotoCarousel({
  slides,
  onDoubleTap,
}: {
  slides: MediaSlide[];
  onDoubleTap: () => void;
}) {
  const [current, setCurrent] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);
  const touchDeltaX = useRef(0);
  const [translateX, setTranslateX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const lastTapRef = useRef(0);

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
    if (touchDeltaX.current < -threshold && current < slides.length - 1) {
      setCurrent((prev) => prev + 1);
    } else if (touchDeltaX.current > threshold && current > 0) {
      setCurrent((prev) => prev - 1);
    }
    setTranslateX(0);
  }, [current, slides.length]);

  // Double-tap detection for mobile
  const handleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      onDoubleTap();
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  }, [onDoubleTap]);

  if (slides.length === 1) {
    return (
      <div
        className="relative w-full overflow-hidden bg-bg-tertiary"
        onDoubleClick={onDoubleTap}
        onClick={handleTap}
      >
        <MediaElement url={slides[0].url} isVideo={slides[0].isVideo} />
      </div>
    );
  }

  return (
    <div
      className="relative w-full overflow-hidden bg-bg-tertiary"
      onDoubleClick={onDoubleTap}
      onClick={handleTap}
    >
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
        {slides.map((slide, i) => (
          <div key={i} className="w-full flex-shrink-0">
            <MediaElement url={slide.url} isVideo={slide.isVideo} />
          </div>
        ))}
      </div>
      {/* Dot indicators */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
        {slides.map((_, i) => (
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

/** Heart animation overlay for double-tap */
function HeartOverlay({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.1 }}
        >
          <motion.span
            className="text-7xl drop-shadow-lg"
            initial={{ scale: 0.2, opacity: 0.8 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 1.4, opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            ❤️
          </motion.span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default function PhotoFeed({ posts, loading, onLike, boardType = "team", playerLabels }: PhotoFeedProps) {
  const [likedPosts, setLikedPosts] = useState<Set<number>>(new Set());
  const [heartPostId, setHeartPostId] = useState<number | null>(null);
  const [commentPostId, setCommentPostId] = useState<number | null>(null);
  const [commentTeamId, setCommentTeamId] = useState<number | null>(null);
  // 댓글 추가 시 로컬 카운트 보정값
  const [commentDeltas, setCommentDeltas] = useState<Record<number, number>>({});

  const handleLike = (postId: number) => {
    setLikedPosts((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
    onLike(postId);
  };

  // Double-tap: always adds like (never removes), Instagram-style
  const handleDoubleTap = (postId: number) => {
    if (!likedPosts.has(postId)) {
      handleLike(postId);
    }
    // Show heart animation
    setHeartPostId(postId);
    setTimeout(() => setHeartPostId(null), 800);
  };

  if (loading) {
    return (
      <div className="divide-y divide-white/[0.02]">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="p-4 animate-pulse">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-bg-tertiary" />
              <div className="h-4 bg-bg-tertiary rounded w-24" />
            </div>
            <div className="w-full aspect-[4/5] bg-bg-tertiary" />
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
    <div>
      {posts.map((post, index) => {
        const grade = getGradeInfo(post.grade);
        const isLiked = likedPosts.has(post.id);

        return (
          <div key={post.id}>
            {/* Post separator */}
            {index > 0 && <div className="h-2 bg-white/[0.02]" />}

            <div className="overflow-hidden">
              {/* Author header — 일반게시판(PostCard) 기준 통일 */}
              <div className="flex items-center gap-3 px-4 py-3">
                {boardType === "player" && playerLabels?.[post.id] ? (
                  <TeamBadge teamId={playerLabels[post.id].teamId} playerName={playerLabels[post.id].playerName} />
                ) : (
                  post.team_id ? <TeamBadge teamId={post.team_id} /> : null
                )}
                <span className="text-base font-medium text-text-primary truncate">
                  {post.nickname || "익명"}
                </span>
                <LevelBadge points={post.points ?? 0} />
                {post.grade === "staff" && (
                  <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-accent/20 text-accent rounded-full">
                    운영팀
                  </span>
                )}
                <span className="ml-auto text-base text-text-tertiary flex-shrink-0">
                  {timeAgo(post.created_at)}
                </span>
              </div>

              {/* Photo/video carousel — full bleed, no padding, no rounded corners */}
              {(post.image_urls.length > 0 || (post.video_urls && post.video_urls.length > 0)) && (
                <div className="relative">
                  <PhotoCarousel
                    slides={[
                      ...post.image_urls.map((url) => ({ url, isVideo: false })),
                      ...(post.video_urls ?? []).map((url) => ({ url, isVideo: true })),
                    ]}
                    onDoubleTap={() => handleDoubleTap(post.id)}
                  />
                  <HeartOverlay show={heartPostId === post.id} />
                </div>
              )}

              {/* Action bar */}
              <div className="flex items-center gap-4 px-4 py-2.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLike(post.id);
                  }}
                  className="flex items-center gap-1 text-base transition-colors"
                >
                  <span className="text-xl leading-none">{isLiked ? "\u2764\uFE0F" : "\u2661"}</span>
                  <span className={isLiked ? "text-red-500 font-medium" : "text-text-secondary"}>
                    {post.like_count + (isLiked ? 1 : 0)}
                  </span>
                </button>
                <button
                  onClick={() => { setCommentPostId(post.id); setCommentTeamId(post.team_id ?? null); }}
                  className="flex items-center gap-1 text-base text-text-secondary"
                >
                  <MessageCircle size={20} />
                  <span>{post.comment_count + (commentDeltas[post.id] ?? 0)}</span>
                </button>
              </div>

              {/* Caption */}
              {post.content && (
                <CaptionBlock
                  nickname={post.nickname || "익명"}
                  content={post.content}
                  onPress={() => { setCommentPostId(post.id); setCommentTeamId(post.team_id ?? null); }}
                />
              )}

              {/* Player tags — clickable, links to player page */}
              {post.player_tags && Array.isArray(post.player_tags) && post.player_tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-4 pb-1">
                  {(post.player_tags as string[]).map((tag: string) => {
                    const { kboId, displayName } = parsePlayerTag(tag);

                    let href: string | undefined;
                    let team: ReturnType<typeof getTeamById> = undefined;

                    if (kboId) {
                      // New format: kboId directly available
                      href = `/community/players/${kboId}`;
                      const rosterEntry = findPlayerByKboId(kboId);
                      team = rosterEntry ? getTeamById(rosterEntry.teamId) : undefined;
                    } else {
                      // Legacy name-only fallback
                      const player = findPlayerByName(displayName);
                      if (player) {
                        href = `/community/players/${player.kboId}`;
                        team = getTeamById(player.teamId);
                      }
                    }

                    const label = team ? `@${team.shortName} ${displayName}` : `@${displayName}`;

                    return href ? (
                      <Link key={tag} href={href} className="text-xs font-medium text-text-secondary bg-bg-tertiary px-2 py-0.5 rounded-full active:bg-bg-quaternary transition-colors">
                        {label}
                      </Link>
                    ) : (
                      <span key={tag} className="text-xs font-medium text-text-secondary bg-bg-tertiary px-2 py-0.5 rounded-full">
                        {label}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Hashtags */}
              {post.hashtags && Array.isArray(post.hashtags) && post.hashtags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-4 pb-1">
                  {(post.hashtags as string[]).map((tag: string) => (
                    <span key={tag} className="text-xs text-accent font-medium">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {commentPostId !== null && (
        <CommentSheet
          isOpen={true}
          onClose={() => { setCommentPostId(null); setCommentTeamId(null); }}
          postId={commentPostId}
          teamId={commentTeamId}
          onCommentAdded={(postId) => {
            setCommentDeltas((prev) => ({ ...prev, [postId]: (prev[postId] ?? 0) + 1 }));
          }}
        />
      )}
    </div>
  );
}

/** 인스타 스타일 캡션: 2줄 초과 시 "더보기" / 펼친 후 클릭하면 접기 */
function CaptionBlock({ nickname, content, onPress }: { nickname: string; content: string; onPress: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // line-clamp가 적용된 상태에서 높이 비교로 clamped 판단
    // 약간의 딜레이를 줘서 렌더 후 측정
    requestAnimationFrame(() => {
      setClamped(el.scrollHeight > el.clientHeight + 2);
    });
  }, [content]);

  return (
    <div className="px-4 pb-1">
      <div
        ref={textRef}
        role="button"
        tabIndex={0}
        onClick={expanded ? () => setExpanded(false) : clamped ? () => setExpanded(true) : onPress}
        className={`text-left text-base cursor-pointer ${!expanded ? "line-clamp-2" : ""}`}
      >
        <span className="font-semibold text-text-primary mr-1.5">{nickname}</span>
        <span className="text-text-secondary">{content}</span>
      </div>
      {clamped && !expanded && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
          className="text-base text-text-tertiary mt-0.5"
        >
          더보기
        </button>
      )}
    </div>
  );
}
