"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { Heart, Volume2, VolumeX, ExternalLink } from "lucide-react";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { HIGHLIGHTS, rankHighlights, type Highlight } from "@/lib/constants/highlights";
import { getMyTeamId } from "@/lib/store/myteam";
import { getFavoritePlayers } from "@/lib/store/favorites";
import { handleExternalAnchorClick } from "@/lib/open-external";

/**
 * YouTube ToS III.C.1 / III.I.4 compliance:
 * - Native controls visible (controls=1) — YouTube logo/link not obscured.
 * - NOTHING is rendered in front of the embedded iframe. All app chrome
 *   (title, like, mute, outlink) lives in flex siblings OUTSIDE the player.
 */
function ReelSlide({
  reel,
  isActive,
  muted,
  liked,
  onLike,
  onToggleMute,
}: {
  reel: Highlight;
  isActive: boolean;
  muted: boolean;
  liked: boolean;
  onLike: () => void;
  onToggleMute: () => void;
}) {
  const t = reel.teamId ? getTeamById(reel.teamId) : null;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // iframe src — mute=1 필수 (모바일 autoplay 정책), controls=1 (ToS 준수)
  const src = isActive
    ? `https://www.youtube.com/embed/${reel.youtubeId}?autoplay=1&mute=${muted ? 1 : 0}&controls=1&rel=0&playsinline=1&loop=1&playlist=${reel.youtubeId}&enablejsapi=1`
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

  const handleMute = () => {
    const cw = iframeRef.current?.contentWindow;
    if (cw) {
      try {
        cw.postMessage(
          JSON.stringify({ event: "command", func: muted ? "unMute" : "mute", args: [] }),
          "*",
        );
      } catch {}
    }
    onToggleMute();
  };

  return (
    <div className="relative h-full w-full snap-start snap-always flex flex-col bg-black">
      {/* Player region — no overlays on the iframe (YouTube ToS III.C.1) */}
      <div className="flex-1 min-h-0 flex items-center justify-center bg-black">
        {isActive ? (
          <iframe
            ref={iframeRef}
            key={reel.id}
            src={src}
            title={reel.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="w-full h-full"
            style={{ border: "none" }}
          />
        ) : (
          <img
            src={reel.thumbnail}
            alt=""
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>

      {/* Info + actions — OUTSIDE the player */}
      <div className="shrink-0 bg-black px-4 pt-3 pb-[calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom))+12px)]">
        <div className="flex items-center gap-2 mb-1">
          {t && (
            <span className="w-6 h-6 rounded-full bg-white p-0.5 flex items-center justify-center shrink-0">
              <Image src={t.logoPath} alt="" width={18} height={18} unoptimized className="object-contain" />
            </span>
          )}
          <span className="text-sm font-bold text-white truncate">{reel.channel}</span>
          {t && (
            <span
              className="text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0"
              style={{ backgroundColor: `${getTeamBgColor(t)}60`, color: t.colorLight }}
            >
              {t.shortName}
            </span>
          )}
          <span className="ml-auto text-xs text-white/40 shrink-0">{reel.timeAgo}</span>
        </div>
        <p className="text-sm text-white/90 leading-snug line-clamp-2 mb-3">{reel.title}</p>
        <div className="flex items-center gap-5">
          <button onClick={onLike} className="flex items-center gap-1.5 active:scale-95 transition-transform">
            <Heart size={22} fill={liked ? "#FF3B5C" : "none"} className={liked ? "text-[#FF3B5C]" : "text-white"} />
            <span className="text-xs text-white font-medium">좋아요</span>
          </button>
          <button onClick={handleMute} className="flex items-center gap-1.5 active:scale-95 transition-transform">
            {muted ? <VolumeX size={22} className="text-white" /> : <Volume2 size={22} className="text-white" />}
            <span className="text-xs text-white font-medium">{muted ? "소리 켜기" : "소리 끄기"}</span>
          </button>
          <a
            href={`https://www.youtube.com/watch?v=${reel.youtubeId}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleExternalAnchorClick(e, `https://www.youtube.com/watch?v=${reel.youtubeId}`)}
            className="ml-auto flex items-center gap-1.5 active:scale-95 transition-transform"
          >
            <ExternalLink size={20} className="text-white" />
            <span className="text-xs text-white font-medium">유튜브</span>
          </a>
        </div>
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
          const ytHighlights: Highlight[] = d.items.map((item: { id: string; title: string; publishedAt: string }) => ({
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
    <div className="fixed inset-0 z-40 bg-black flex flex-col">
      {/* Header (outside the scroll/player area) */}
      <div className="shrink-0 pt-safe">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-lg font-bold text-white">영상</h1>
          <span className="text-xs text-white/50 tabular-nums">{currentIdx + 1} / {feed.length}</span>
        </div>
      </div>

      {/* Vertical snap scroll — swipe between videos still works */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 w-full overflow-y-auto snap-y snap-mandatory hide-scrollbar"
      >
        {feed.map((reel, idx) => (
          <ReelSlide
            key={reel.id}
            reel={reel}
            isActive={idx === currentIdx}
            muted={muted}
            liked={liked.has(reel.id)}
            onLike={() => toggleLike(reel.id)}
            onToggleMute={() => setMuted(m => !m)}
          />
        ))}
      </div>
    </div>
  );
}
