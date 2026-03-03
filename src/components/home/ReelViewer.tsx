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

export default function ReelViewer({ videos, startIndex, onClose }: ReelViewerProps) {
  const [current, setCurrent] = useState(startIndex);
  const [muted, setMuted] = useState(true);
  const touchStartY = useRef(0);
  const touchMoved = useRef(false);

  const video = videos[current];

  const goNext = useCallback(() => {
    if (current < videos.length - 1) setCurrent(c => c + 1);
  }, [current, videos.length]);

  const goPrev = useCallback(() => {
    if (current > 0) setCurrent(c => c - 1);
  }, [current]);

  // 터치 이벤트를 overlay div에서 처리
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    touchMoved.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const diff = Math.abs(e.touches[0].clientY - touchStartY.current);
    if (diff > 10) touchMoved.current = true;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchMoved.current) return;
    const diff = touchStartY.current - e.changedTouches[0].clientY;
    if (diff > 60) goNext();
    else if (diff < -60) goPrev();
  };

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  return (
    <div className="fixed inset-0 z-[100] bg-black">
      {/* YouTube iframe (뒤에) - autoplay + mute for mobile policy */}
      <iframe
        key={`${video.id}-${muted}`}
        src={`https://www.youtube.com/embed/${video.id}?autoplay=1&mute=${muted ? 1 : 0}&controls=0&rel=0&playsinline=1&loop=1&playlist=${video.id}&modestbranding=1`}
        className="absolute inset-0 w-full h-full"
        allow="autoplay; encrypted-media"
        allowFullScreen
      />

      {/* 터치 감지 overlay (앞에) */}
      <div
        className="absolute inset-0 z-10"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />

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

      {/* 사운드 + 네비게이션 버튼 */}
      <div className="absolute right-4 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-4">
        <button onClick={() => setMuted(m => !m)} className="p-2 rounded-full bg-black/50">
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
