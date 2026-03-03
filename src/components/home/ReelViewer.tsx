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
  const containerRef = useRef<HTMLDivElement>(null);

  const video = videos[current];

  // 스크롤 방지
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // 세로 스냅 스크롤로 이동
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: current * window.innerHeight, behavior: "smooth" });
  }, [current]);

  // 스크롤 위치로 현재 인덱스 업데이트
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollTop / window.innerHeight);
    if (idx !== current && idx >= 0 && idx < videos.length) {
      setCurrent(idx);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black">
      {/* 닫기 버튼 */}
      <button
        onClick={onClose}
        className="absolute top-[calc(env(safe-area-inset-top)+12px)] right-4 z-20 p-2 rounded-full bg-black/50"
      >
        <X size={24} className="text-white" />
      </button>

      {/* 세로 스냅 스크롤 컨테이너 */}
      <div
        ref={containerRef}
        className="h-full overflow-y-auto scrollbar-hide"
        style={{ scrollSnapType: "y mandatory" }}
        onScroll={handleScroll}
      >
        {videos.map((v, i) => (
          <div
            key={v.id}
            className="relative w-full flex items-center justify-center"
            style={{ height: "100dvh", scrollSnapAlign: "start" }}
          >
            {/* 현재 ±1 범위만 iframe 렌더 (성능) */}
            {Math.abs(i - current) <= 1 ? (
              <iframe
                src={i === current
                  ? `https://www.youtube.com/embed/${v.id}?autoplay=1&mute=0&controls=1&rel=0&playsinline=1&loop=1&playlist=${v.id}`
                  : `https://www.youtube.com/embed/${v.id}?autoplay=0&controls=1&rel=0&playsinline=1`
                }
                className="w-full h-full"
                allow="autoplay; encrypted-media"
                allowFullScreen
              />
            ) : (
              <div className="w-full h-full bg-black flex items-center justify-center">
                <span className="text-white/30 text-sm">스와이프하여 재생</span>
              </div>
            )}

            {/* 오버레이 정보 */}
            <div className="absolute bottom-0 left-0 right-0 z-10 px-4 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-10 bg-gradient-to-t from-black/70 to-transparent pointer-events-none">
              {v.label && (
                <span className="inline-block px-2 py-0.5 mb-2 rounded-full bg-accent/80 text-xs font-semibold text-white">
                  {v.label}
                </span>
              )}
              <p className="text-white text-sm font-medium line-clamp-2">{v.title}</p>
            </div>
          </div>
        ))}
      </div>

      {/* 인디케이터 */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex flex-col gap-1">
        {videos.map((_, i) => (
          <div
            key={i}
            className={`w-1.5 rounded-full transition-all ${i === current ? "h-4 bg-accent" : "h-1.5 bg-white/30"}`}
          />
        ))}
      </div>
    </div>
  );
}
