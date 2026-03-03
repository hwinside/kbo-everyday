"use client";

import { useState, useRef, useEffect } from "react";
import { X } from "lucide-react";

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
  const touchStartY = useRef(0);

  const video = videos[current];

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const diff = touchStartY.current - e.changedTouches[0].clientY;
    if (Math.abs(diff) > 80) {
      if (diff > 0 && current < videos.length - 1) setCurrent(c => c + 1);
      else if (diff < 0 && current > 0) setCurrent(c => c - 1);
    }
  };

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black flex flex-col"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 pt-[env(safe-area-inset-top)] py-3">
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

      {/* Video */}
      <div className="flex-1">
        <iframe
          key={video.id}
          src={`https://www.youtube.com/embed/${video.id}?autoplay=1&mute=0&controls=1&rel=0&playsinline=1&loop=1&playlist=${video.id}`}
          className="w-full h-full"
          allow="autoplay; encrypted-media"
          allowFullScreen
        />
      </div>

      {/* Title + swipe hint */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-8 bg-gradient-to-t from-black/80 to-transparent pointer-events-none">
        <p className="text-white text-sm font-medium line-clamp-2">{video.title}</p>
        <p className="text-white/40 text-xs mt-1">↑ 스와이프하여 다음 영상</p>
      </div>
    </div>
  );
}
