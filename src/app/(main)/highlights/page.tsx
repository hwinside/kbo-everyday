"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import { Heart, MessageCircle, Share2, ChevronUp, Volume2, VolumeX } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import { HIGHLIGHTS, rankHighlights, type Highlight } from "@/lib/constants/highlights";
import { getMyTeamId } from "@/lib/store/myteam";
import { getFavoritePlayers } from "@/lib/store/favorites";

function ReelSlide({
  reel,
  isActive,
  muted,
  liked,
  onLike,
  onMute,
}: {
  reel: Highlight;
  isActive: boolean;
  muted: boolean;
  liked: boolean;
  onLike: () => void;
  onMute: () => void;
}) {
  const t = reel.teamId ? getTeamById(reel.teamId) : null;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  // iframe src — mute=1 필수 (모바일 autoplay 정책)
  const src = isActive
    ? `https://www.youtube.com/embed/${reel.youtubeId}?autoplay=1&mute=${muted ? 1 : 0}&controls=0&modestbranding=1&rel=0&playsinline=1&loop=1&playlist=${reel.youtubeId}&enablejsapi=1`
    : undefined;

  // postMessage로 play/pause 제어
  useEffect(() => {
    if (!iframeRef.current?.contentWindow) return;
    try {
      const cmd = isActive
        ? '{"event":"command","func":"playVideo","args":""}'
        : '{"event":"command","func":"pauseVideo","args":""}';
      iframeRef.current.contentWindow.postMessage(cmd, "*");
    } catch {}
  }, [isActive]);

  return (
    <div className="relative h-full w-full snap-start snap-always flex items-center justify-center bg-black">
      {/* Thumbnail (always visible as background) */}
      <img
        src={reel.thumbnail}
        alt=""
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* YouTube iframe (only when active) */}
      {isActive && (
        <iframe
          ref={iframeRef}
          key={reel.id}
          src={src}
          title={reel.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          onLoad={() => setLoaded(true)}
          className="absolute inset-0 w-full h-full z-[1]"
          style={{ border: "none" }}
        />
      )}

      {/* Gradients */}
      <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/60 to-transparent pointer-events-none z-[2]" />
      <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-black/80 to-transparent pointer-events-none z-[2]" />

      {/* Right actions */}
      <div className="absolute right-3 bottom-32 flex flex-col items-center gap-5 z-[3]">
        {t && (
          <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center shadow-lg">
            <Image src={t.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
          </div>
        )}
        <button onClick={onLike} className="flex flex-col items-center gap-1">
          <Heart size={28} fill={liked ? "#FF3B5C" : "none"} className={liked ? "text-[#FF3B5C]" : "text-white"} />
          <span className="text-xs text-white font-medium">좋아요</span>
        </button>
        <button className="flex flex-col items-center gap-1">
          <MessageCircle size={28} className="text-white" />
          <span className="text-xs text-white font-medium">댓글</span>
        </button>
        <button className="flex flex-col items-center gap-1">
          <Share2 size={28} className="text-white" />
          <span className="text-xs text-white font-medium">공유</span>
        </button>
        <button 
          className="flex flex-col items-center gap-1"
          onClick={() => window.open(`https://www.youtube.com/watch?v=${reel.youtubeId}`, "_blank")}
        >
          <Volume2 size={28} className="text-white" />
          <span className="text-xs text-white font-medium">소리</span>
        </button>
        
      </div>

      {/* Bottom info */}
      <div className="absolute left-4 right-16 bottom-24 z-[3]">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm font-bold text-white">{reel.channel}</span>
          {t && (
            <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${t.colorPrimary}60`, color: t.colorLight }}>
              {t.shortName}
            </span>
          )}
        </div>
        <p className="text-sm text-white/90 leading-snug line-clamp-2">{reel.title}</p>
        <p className="mt-1 text-xs text-white/50">{reel.timeAgo}</p>
      </div>
    </div>
  );
}

export default function HighlightsPage() {
  const [feed, setFeed] = useState<Highlight[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [muted, setMuted] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const teamId = getMyTeamId();
    const favNames = getFavoritePlayers().map(p => p.name);
    // 실시간 YouTube 하이라이트 로딩
    fetch("/api/highlights")
      .then(r => r.json())
      .then(d => {
        if (d.items?.length) {
          const ytHighlights: Highlight[] = d.items.map((item: any, i: number) => ({
            id: `yt-${item.id}`,
            youtubeId: item.id,
            title: item.title,
            date: new Date(item.publishedAt).toLocaleDateString("ko-KR"),
            teamId: null,
            tags: [],
          }));
          setFeed(ytHighlights);
        } else {
          setFeed(rankHighlights(HIGHLIGHTS, teamId, favNames));
        }
      })
      .catch(() => {
        setFeed(rankHighlights(HIGHLIGHTS, teamId, favNames));
      });
  }, []);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollTop / el.clientHeight);
    setCurrentIdx(prev => (idx >= 0 && idx < feed.length && idx !== prev) ? idx : prev);
  }, [feed.length]);

  const toggleLike = (id: string) => {
    setLiked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (!feed.length) return null;

  return (
    <div className="fixed inset-0 z-40 bg-black">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 pt-safe">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-lg font-bold text-white drop-shadow-lg">영상</h1>
          <span className="text-xs text-white/50 tabular-nums">{currentIdx + 1} / {feed.length}</span>
        </div>
      </div>

      {/* Vertical snap scroll */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full w-full overflow-y-auto snap-y snap-mandatory hide-scrollbar"
      >
        {feed.map((reel, idx) => (
          <ReelSlide
            key={reel.id}
            reel={reel}
            isActive={idx === currentIdx}
            muted={muted}
            liked={liked.has(reel.id)}
            onLike={() => toggleLike(reel.id)}
            onMute={() => setMuted(!muted)}
          />
        ))}
      </div>

      {/* First slide hint */}
      {currentIdx === 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 2 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center text-white/40 z-10 pointer-events-none"
        >
          <ChevronUp size={20} className="animate-bounce" />
          <span className="text-xs">위로 스와이프</span>
        </motion.div>
      )}
    </div>
  );
}
