"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronUp, ChevronDown, Volume2, VolumeX } from "lucide-react";

interface ReelVideo {
  id: string;
  title: string;
  label?: string;
}

interface ReelViewerProps {
  videos: ReelVideo[];
  startIndex: number;
  onClose: () => void;
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

function loadYTAPI(): Promise<void> {
  return new Promise((resolve) => {
    if (window.YT?.Player) { resolve(); return; }
    const existing = document.getElementById("yt-iframe-api");
    if (existing) {
      const check = setInterval(() => {
        if (window.YT?.Player) { clearInterval(check); resolve(); }
      }, 100);
      return;
    }
    window.onYouTubeIframeAPIReady = () => resolve();
    const tag = document.createElement("script");
    tag.id = "yt-iframe-api";
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
}

export default function ReelViewer({ videos, startIndex, onClose }: ReelViewerProps) {
  const [current, setCurrent] = useState(startIndex);
  const [muted, setMuted] = useState(true);
  const [ready, setReady] = useState(false);
  const playerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef(0);
  const touchMoved = useRef(false);

  const video = videos[current];

  // YT Player 초기화
  useEffect(() => {
    let destroyed = false;
    loadYTAPI().then(() => {
      if (destroyed) return;
      playerRef.current = new window.YT.Player("reel-yt-player", {
        videoId: videos[startIndex].id,
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 1,
          rel: 0,
          playsinline: 1,
          modestbranding: 1,
        },
        events: {
          onReady: (e: any) => {
            e.target.playVideo();
            setReady(true);
          },
          onStateChange: (e: any) => {
            // 영상 끝나면 다음으로
            if (e.data === window.YT.PlayerState.ENDED) {
              setCurrent(c => Math.min(c + 1, videos.length - 1));
            }
          },
        },
      });
    });
    return () => {
      destroyed = true;
      try { playerRef.current?.destroy(); } catch {}
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 영상 변경
  useEffect(() => {
    if (!ready || !playerRef.current) return;
    playerRef.current.loadVideoById(video.id);
    if (!muted) {
      setTimeout(() => playerRef.current?.unMute(), 300);
    }
  }, [video.id, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // body scroll lock
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const goNext = useCallback(() => {
    if (current < videos.length - 1) setCurrent(c => c + 1);
  }, [current, videos.length]);

  const goPrev = useCallback(() => {
    if (current > 0) setCurrent(c => c - 1);
  }, [current]);

  const toggleMute = useCallback(() => {
    if (!playerRef.current) return;
    if (muted) {
      playerRef.current.unMute();
      playerRef.current.setVolume(100);
    } else {
      playerRef.current.mute();
    }
    setMuted(m => !m);
  }, [muted]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    touchMoved.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (Math.abs(e.touches[0].clientY - touchStartY.current) > 10) touchMoved.current = true;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchMoved.current) {
      toggleMute();
      return;
    }
    const diff = touchStartY.current - e.changedTouches[0].clientY;
    if (diff > 60) goNext();
    else if (diff < -60) goPrev();
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black">
      {/* YT Player 컨테이너 */}
      <div ref={containerRef} className="absolute inset-0">
        <div id="reel-yt-player" className="w-full h-full" />
      </div>

      {/* 터치 오버레이 */}
      <div
        className="absolute inset-0 z-10"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />

      {/* 음소거 안내 */}
      {muted && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="bg-black/60 rounded-full px-4 py-2 flex items-center gap-2 animate-pulse">
            <VolumeX size={20} className="text-white" />
            <span className="text-white text-sm">탭하여 소리 켜기</span>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 pt-[env(safe-area-inset-top)] py-3">
        <button onClick={onClose} className="p-2 rounded-full bg-black/50">
          <X size={24} className="text-white" />
        </button>
        <div className="flex items-center gap-2">
          {video.label && (
            <span className="px-2.5 py-1 rounded-full bg-accent/80 text-xs font-semibold text-white">
              {video.label}
            </span>
          )}
          <span className="text-white/60 text-xs">{current + 1}/{videos.length}</span>
        </div>
      </div>

      {/* 사운드 + 네비게이션 */}
      <div className="absolute right-4 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-4">
        <button onClick={toggleMute} className="p-2 rounded-full bg-black/50">
          {muted ? <VolumeX size={24} className="text-white" /> : <Volume2 size={24} className="text-white" />}
        </button>
        {current > 0 && (
          <button onClick={goPrev} className="p-2 rounded-full bg-black/50">
            <ChevronUp size={24} className="text-white" />
          </button>
        )}
        {current < videos.length - 1 && (
          <button onClick={goNext} className="p-2 rounded-full bg-black/50">
            <ChevronDown size={24} className="text-white" />
          </button>
        )}
      </div>

      {/* Title */}
      <div className="absolute bottom-0 left-0 right-0 z-20 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-8 bg-gradient-to-t from-black/80 to-transparent pointer-events-none">
        <p className="text-white text-sm font-medium line-clamp-2">{video.title}</p>
      </div>
    </div>
  );
}
