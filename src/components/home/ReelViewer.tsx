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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const touchStartY = useRef(0);
  const touchMoved = useRef(false);

  const video = videos[current];

  const goNext = useCallback(() => {
    if (current < videos.length - 1) setCurrent(c => c + 1);
  }, [current, videos.length]);

  const goPrev = useCallback(() => {
    if (current > 0) setCurrent(c => c - 1);
  }, [current]);

  // YouTube postMessage로 음소거 토글
  const toggleMute = useCallback(() => {
    const iframe = iframeRef.current;
    if (iframe?.contentWindow) {
      const cmd = muted ? "unMute" : "mute";
      iframe.contentWindow.postMessage(
        JSON.stringify({ event: "command", func: cmd, args: [] }),
        "*"
      );
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
      // 탭 = 음소거 해제
      toggleMute();
      return;
    }
    const diff = touchStartY.current - e.changedTouches[0].clientY;
    if (diff > 60) goNext();
    else if (diff < -60) goPrev();
  };

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // 영상 바뀌면 mute 유지
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe?.contentWindow && !muted) {
      setTimeout(() => {
        iframe.contentWindow?.postMessage(
          JSON.stringify({ event: "command", func: "unMute", args: [] }),
          "*"
        );
      }, 1000);
    }
  }, [current, muted]);

  return (
    <div className="fixed inset-0 z-[100] bg-black">
      {/* YouTube iframe - enablejsapi=1 필수 */}
      <iframe
        ref={iframeRef}
        key={video.id}
        src={`https://www.youtube.com/embed/${video.id}?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&loop=1&playlist=${video.id}&modestbranding=1&enablejsapi=1&origin=${typeof window !== "undefined" ? window.location.origin : ""}`}
        className="absolute inset-0 w-full h-full"
        allow="autoplay; encrypted-media"
        allowFullScreen
      />

      {/* 터치 오버레이 (탭=음소거해제, 스와이프=다음영상) */}
      <div
        className="absolute inset-0 z-10"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />

      {/* 음소거 안내 (처음만) */}
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
