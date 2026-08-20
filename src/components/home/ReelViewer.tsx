"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { X, ChevronUp, ChevronDown, Volume2, VolumeX, ExternalLink } from "lucide-react";
import { handleExternalAnchorClick } from "@/lib/open-external";
import { trackShortsView } from "@/lib/content-views/tracker";
import { useContentViewCounts } from "@/hooks/useContentViewCounts";
import ContentViewBadge from "@/components/admin/ContentViewBadge";
import type { ContentViewType } from "@/lib/content-views/policy";

interface ReelVideo {
  thumbnail?: string;
  id: string;
  title: string;
  label?: string;
  /** 조회수 서명(피드 API 발급) — 없으면 조회수 미집계(best-effort). */
  viewToken?: string;
}

interface ReelViewerProps {
  videos: ReelVideo[];
  startIndex: number;
  onClose: () => void;
}

/**
 * YouTube ToS III.C.1 / III.I.4 compliance:
 * - controls=1 (native controls + YouTube link visible).
 * - No element is rendered in front of the iframe. Swipe is handled by
 *   container-level touch handlers; the cross-origin iframe captures its own
 *   touches, so the player surface is never covered by an overlay element.
 *   App chrome (header, title, mute, nav) sits in flex siblings outside it.
 * - Opens with muted autoplay (mobile policy allows autoplay only when muted).
 */
export default function ReelViewer({ videos, startIndex, onClose }: ReelViewerProps) {
  const [current, setCurrent] = useState(startIndex);
  const [muted, setMuted] = useState(true); // 뮤트로 시작 (muted여야 autoplay 허용)
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const touchStartY = useRef(0);
  const touchMoved = useRef(false);
  const prevVideoId = useRef(videos[startIndex].id);

  const video = videos[current];

  // 조회수: 현재 영상이 노출될 때 +1 (세션당 영상 1회 dedup — tracker 내부).
  useEffect(() => {
    trackShortsView(video.id, video.viewToken);
  }, [video.id, video.viewToken]);

  // 관리자 전용 조회수 배지 — 관리자가 아니면 hook이 요청 자체를 안 한다.
  const viewCountItems = useMemo(
    () => videos.map((v) => ({ type: "shorts" as ContentViewType, id: v.id })),
    [videos],
  );
  const viewCounts = useContentViewCounts(viewCountItems);

  const postCmd = useCallback((func: string, args: (string | number | boolean)[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }, []);

  const goNext = useCallback(() => {
    if (current < videos.length - 1) setCurrent(c => c + 1);
  }, [current, videos.length]);

  const goPrev = useCallback(() => {
    if (current > 0) setCurrent(c => c - 1);
  }, [current]);

  const toggleMute = useCallback(() => {
    postCmd(muted ? "unMute" : "mute");
    setMuted(m => !m);
  }, [muted, postCmd]);

  // 스와이프 — 컨테이너 레벨 핸들러(플레이어 위 오버레이 요소 없음).
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    touchMoved.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (Math.abs(e.touches[0].clientY - touchStartY.current) > 10) touchMoved.current = true;
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

  // 영상 변경 시 loadVideoById (단일 iframe 재사용)
  useEffect(() => {
    if (video.id === prevVideoId.current) return;
    prevVideoId.current = video.id;
    postCmd("loadVideoById", [video.id]);
    if (muted) {
      setTimeout(() => postCmd("mute"), 300);
    }
  }, [video.id, muted, postCmd]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black flex flex-col"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Header — outside player */}
      <div className="shrink-0 flex items-center justify-between px-4 pt-[var(--safe-area-inset-top,env(safe-area-inset-top))] py-3">
        <button onClick={onClose} className="p-2 rounded-full bg-white/10">
          <X size={22} className="text-white" />
        </button>
        <div className="flex items-center gap-2">
          {video.label && (
            <span className="px-2.5 py-1 rounded-full bg-accent/80 text-xs font-semibold text-white">{video.label}</span>
          )}
          <ContentViewBadge count={viewCounts[`shorts:${video.id}`]} className="!text-white/60" />
          <span className="text-white/60 text-xs">{current + 1}/{videos.length}</span>
        </div>
      </div>

      {/* Player region — no overlays on the iframe (YouTube ToS III.C.1). Muted autoplay on open. */}
      <div className="flex-1 min-h-0 flex items-center justify-center bg-black">
        <iframe
          ref={iframeRef}
          src={`https://www.youtube.com/embed/${videos[startIndex].id}?autoplay=1&mute=1&controls=1&rel=0&playsinline=1&enablejsapi=1&origin=${typeof window !== "undefined" ? window.location.origin : ""}`}
          className="w-full h-full"
          style={{ border: "none" }}
          allow="autoplay; encrypted-media"
          allowFullScreen
        />
      </div>

      {/* Title + actions + nav — outside player */}
      <div className="shrink-0 bg-black px-4 pt-3 pb-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom))+12px)]">
        <p className="text-white text-sm font-medium line-clamp-2 mb-3">{video.title}</p>
        <div className="flex items-center gap-5">
          <button onClick={toggleMute} className="flex items-center gap-1.5 active:scale-95 transition-transform">
            {muted ? <VolumeX size={22} className="text-white" /> : <Volume2 size={22} className="text-white" />}
            <span className="text-xs text-white font-medium">{muted ? "소리 켜기" : "소리 끄기"}</span>
          </button>
          <a
            href={`https://www.youtube.com/watch?v=${video.id}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleExternalAnchorClick(e, `https://www.youtube.com/watch?v=${video.id}`)}
            className="flex items-center gap-1.5 active:scale-95 transition-transform"
          >
            <ExternalLink size={20} className="text-white" />
            <span className="text-xs text-white font-medium">유튜브</span>
          </a>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={goPrev} disabled={current === 0} className="p-2 rounded-full bg-white/10 disabled:opacity-30" aria-label="이전 영상">
              <ChevronUp size={22} className="text-white" />
            </button>
            <button onClick={goNext} disabled={current === videos.length - 1} className="p-2 rounded-full bg-white/10 disabled:opacity-30" aria-label="다음 영상">
              <ChevronDown size={22} className="text-white" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
