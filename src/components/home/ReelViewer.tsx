"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronUp, ChevronDown, Volume2, VolumeX, RotateCcw } from "lucide-react";
import { Play } from "lucide-react";

interface ReelVideo {
  thumbnail?: string;
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
  const [muted, setMuted] = useState(true); // 뮤트로 시작
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const touchStartY = useRef(0);
  const touchMoved = useRef(false);
  const prevVideoId = useRef(videos[startIndex].id);

  const video = videos[current];

  const postCmd = useCallback((func: string, args: (string | number | boolean)[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }, []);

  const goNext = useCallback(() => {
    if (current < videos.length - 1) {
      setCurrent(c => c + 1);
      setEnded(false);
    }
  }, [current, videos.length]);

  const goPrev = useCallback(() => {
    if (current > 0) {
      setCurrent(c => c - 1);
      setEnded(false);
    }
  }, [current]);

  const toggleMute = useCallback(() => {
    postCmd(muted ? "unMute" : "mute");
    setMuted(m => !m);
  }, [muted, postCmd]);

  const replay = useCallback(() => {
    postCmd("seekTo", [0, true]);
    postCmd("playVideo");
    setEnded(false);
  }, [postCmd]);

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

  // 재생 시작 (탭) — iframe은 이미 로드됨, playVideo만 호출
  const handleStart = () => {
    postCmd("playVideo");
    setStarted(true);
  };

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // 영상 변경 시 loadVideoById
  useEffect(() => {
    if (!started) return;
    if (video.id === prevVideoId.current) return;
    prevVideoId.current = video.id;
    postCmd("loadVideoById", [video.id]);
    if (muted) {
      setTimeout(() => postCmd("mute"), 300);
    }
  }, [video.id, started, muted, postCmd]);

  // YT IFrame API: ENDED(0) 감지 → 커스텀 다시보기 버튼 노출
  useEffect(() => {
    if (!started) return;
    const onMessage = (e: MessageEvent) => {
      if (typeof e.origin !== "string" || !e.origin.includes("youtube.com")) return;
      if (typeof e.data !== "string") return;
      let payload: { event?: string; info?: number | { playerState?: number } };
      try { payload = JSON.parse(e.data); } catch { return; }
      // onStateChange: info = state code (0=ended, 1=playing, ...)
      if (payload.event === "onStateChange") {
        if (payload.info === 0) setEnded(true);
        else if (payload.info === 1) setEnded(false);
        return;
      }
      // infoDelivery: info.playerState = state code
      if (payload.event === "infoDelivery" && typeof payload.info === "object" && payload.info) {
        const ps = payload.info.playerState;
        if (ps === 0) setEnded(true);
        else if (ps === 1) setEnded(false);
      }
    };
    window.addEventListener("message", onMessage);
    // 이벤트 수신 등록 (enablejsapi=1 + listening 메시지 필요)
    const register = () => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: "kbo-reel", channel: "widget" }),
        "*"
      );
    };
    register();
    const t = setTimeout(register, 500);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(t);
    };
  }, [started, video.id]);

  return (
    <div className="fixed inset-0 z-[100] bg-black">
      {/* 시작 전: 썸네일 + 재생 버튼 */}
      {!started && (
        <div className="absolute inset-0 z-30 flex items-center justify-center" onClick={handleStart}>
          <img
            src={video.thumbnail || `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative w-20 h-20 rounded-full bg-white/90 flex items-center justify-center shadow-2xl active:scale-95 transition-transform">
            <Play size={36} className="text-black ml-1.5" fill="black" />
          </div>
          {/* 제목 */}
          <div className="absolute bottom-0 left-0 right-0 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-8 bg-gradient-to-t from-black/80 to-transparent">
            <p className="text-white text-sm font-medium line-clamp-2">{video.title}</p>
          </div>
          {/* 닫기 */}
          <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 pt-[env(safe-area-inset-top)] py-3">
            <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="p-2 rounded-full bg-black/50">
              <X size={24} className="text-white" />
            </button>
            <span className="text-white/60 text-xs">{current + 1}/{videos.length}</span>
          </div>
        </div>
      )}

      {/* iframe — 항상 렌더 (시작 전엔 썸네일 뒤에 숨김) */}
      <iframe
        ref={iframeRef}
        src={`https://www.youtube.com/embed/${videos[startIndex].id}?autoplay=0&mute=1&controls=1&rel=0&playsinline=1&enablejsapi=1&origin=${typeof window !== "undefined" ? window.location.origin : ""}`}
        className="absolute inset-0 w-full h-full"
        allow="autoplay; encrypted-media"
        allowFullScreen
      />

      {started && (
        <>

          {/* 터치 오버레이 */}
          <div
            className="absolute inset-0 z-10"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          />

          {/* 다시보기 버튼 (영상 종료 시) */}
          {ended && (
            <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
              <button
                onClick={(e) => { e.stopPropagation(); replay(); }}
                className="pointer-events-auto flex flex-col items-center gap-2 px-6 py-5 rounded-2xl bg-black/70 backdrop-blur-sm active:scale-95 transition-transform"
                aria-label="다시보기"
              >
                <RotateCcw size={36} className="text-white" />
                <span className="text-white text-sm font-medium">다시보기</span>
              </button>
            </div>
          )}

          {/* Header */}
          <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 pt-[env(safe-area-inset-top)] py-3">
            <button onClick={onClose} className="p-2 rounded-full bg-black/50">
              <X size={24} className="text-white" />
            </button>
            <div className="flex items-center gap-2">
              {video.label && (
                <span className="px-2.5 py-1 rounded-full bg-accent/80 text-xs font-semibold text-white">{video.label}</span>
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
        </>
      )}
    </div>
  );
}
