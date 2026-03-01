"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import { Heart, MessageCircle, Share2, ChevronUp, Volume2, VolumeX } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import { HIGHLIGHTS, rankHighlights, type Highlight } from "@/lib/constants/highlights";
import { getMyTeamId } from "@/lib/store/myteam";

// YouTube IFrame API 타입
declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

function loadYTApi(): Promise<void> {
  return new Promise((resolve) => {
    if (window.YT?.Player) { resolve(); return; }
    window.onYouTubeIframeAPIReady = () => resolve();
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
  });
}

export default function HighlightsPage() {
  const [myTeamId, setMyTeam] = useState<number | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [muted, setMuted] = useState(true); // 기본 음소거 (모바일 autoplay 필수)
  const [feed, setFeed] = useState<Highlight[]>([]);
  const [ytReady, setYtReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const playersRef = useRef<Map<number, any>>(new Map());
  const [userInteracted, setUserInteracted] = useState(false);

  useEffect(() => {
    const teamId = getMyTeamId();
    setMyTeam(teamId);
    setFeed(rankHighlights(HIGHLIGHTS, teamId));
    loadYTApi().then(() => setYtReady(true));
  }, []);

  // 첫 터치/클릭 시 인터랙션 플래그
  useEffect(() => {
    const handler = () => { setUserInteracted(true); };
    window.addEventListener("touchstart", handler, { once: true });
    window.addEventListener("click", handler, { once: true });
    return () => {
      window.removeEventListener("touchstart", handler);
      window.removeEventListener("click", handler);
    };
  }, []);

  // YT Player 생성/재생 관리
  useEffect(() => {
    if (!ytReady || feed.length === 0) return;

    const map = playersRef.current;

    // 현재 + 앞뒤 1개 플레이어 생성
    for (let offset = -1; offset <= 1; offset++) {
      const idx = currentIdx + offset;
      if (idx < 0 || idx >= feed.length) continue;
      if (map.has(idx)) continue;

      const reel = feed[idx];
      const containerId = `yt-player-${idx}`;
      const el = document.getElementById(containerId);
      if (!el) continue;

      try {
        if (!document.getElementById(containerId)) continue;
        const player = new window.YT.Player(containerId, {
          videoId: reel.youtubeId,
          playerVars: {
            autoplay: 0,
            mute: 1,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            loop: 1,
            playlist: reel.youtubeId,
          },
          events: {
            onReady: () => {
              try {
                if (idx === currentIdx) player.playVideo();
              } catch {}
            },
            onError: () => {},
          },
        });
        map.set(idx, player);
      } catch {}
    }

    // 현재 영상 재생, 나머지 일시정지
    map.forEach((player, idx) => {
      try {
        if (!player?.getPlayerState) return;
        if (idx === currentIdx) {
          player.playVideo();
          if (muted) player.mute(); else player.unMute();
        } else {
          player.pauseVideo();
        }
      } catch {}
    });

    // 먼 슬라이드 플레이어 정리 (메모리)
    // 먼 슬라이드 정리 (destroy 대신 pause만)
    map.forEach((player, idx) => {
      if (Math.abs(idx - currentIdx) > 3) {
        try { player.pauseVideo?.(); } catch {}
      }
    });
  }, [currentIdx, ytReady, feed, muted]);

  // 뮤트 토글
  useEffect(() => {
    playersRef.current.forEach((player, idx) => {
      try {
        if (idx === currentIdx) {
          if (muted) player.mute?.(); else player.unMute?.();
        }
      } catch {}
    });
  }, [muted, currentIdx]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollTop / el.clientHeight);
    if (idx !== currentIdx && idx >= 0 && idx < feed.length) {
      setCurrentIdx(idx);
    }
  }, [currentIdx, feed.length]);

  const toggleLike = (id: string) => {
    setLiked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (feed.length === 0) return null;

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
        {feed.map((reel, idx) => {
          const t = reel.teamId ? getTeamById(reel.teamId) : null;
          const isActive = idx === currentIdx;
          const isNear = Math.abs(idx - currentIdx) <= 1;
          const isLiked = liked.has(reel.id);

          return (
            <div key={reel.id} className="relative h-full w-full snap-start snap-always flex items-center justify-center">
              {/* YouTube Player container */}
              {isNear ? (
                <div id={`yt-player-${idx}`} className="absolute inset-0 w-full h-full" />
              ) : (
                <img src={reel.thumbnail} alt="" className="absolute inset-0 w-full h-full object-cover" />
              )}

              {/* Gradients */}
              <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/60 to-transparent pointer-events-none" />
              <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />

              {/* Right actions */}
              <div className="absolute right-3 bottom-32 flex flex-col items-center gap-5 z-10">
                {t && (
                  <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center shadow-lg">
                    <Image src={t.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
                  </div>
                )}
                <button onClick={() => toggleLike(reel.id)} className="flex flex-col items-center gap-1">
                  <Heart size={28} fill={isLiked ? "#FF3B5C" : "none"} className={isLiked ? "text-[#FF3B5C]" : "text-white"} />
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
                <button onClick={() => setMuted(!muted)}>
                  {muted ? <VolumeX size={22} className="text-white/70" /> : <Volume2 size={22} className="text-white/70" />}
                </button>
              </div>

              {/* Bottom info */}
              <div className="absolute left-4 right-16 bottom-24 z-10">
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

              {/* First slide hint */}
              {idx === 0 && isActive && !userInteracted && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1.5 }}
                  className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center text-white/50 z-10"
                >
                  <ChevronUp size={20} className="animate-bounce" />
                  <span className="text-xs">위로 스와이프</span>
                </motion.div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
