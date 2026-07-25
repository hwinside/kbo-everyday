"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronUp, ChevronDown, Volume2, VolumeX, ExternalLink, MessageCircle, Loader2 } from "lucide-react";
import { handleExternalAnchorClick } from "@/lib/open-external";
import { useAuth } from "@/lib/supabase/AuthContext";
import { youtubeShortsDiscussion } from "@/lib/news/youtube-shorts-discussion";
import CommentSheet from "@/components/community/CommentSheet";
import LoginSheet from "@/components/auth/LoginSheet";

interface ReelVideo {
  thumbnail?: string;
  id: string;
  title: string;
  label?: string;
  teamId?: string | number | null;
}

interface ReelViewerProps {
  videos: ReelVideo[];
  startIndex: number;
  teamId?: number | null;
  commentCounts?: Record<string, number>;
  onCommentCountChange?: (videoId: string, count: number) => void;
  onClose: () => void;
}

function normalizeTeamId(value: string | number | null | undefined): number | null {
  const teamId = Number(value);
  return Number.isInteger(teamId) && teamId >= 1 && teamId <= 10 ? teamId : null;
}

/**
 * YouTube ToS III.C.1 / III.I.4 compliance:
 * - controls=1 (native controls + YouTube link visible).
 * - No element is rendered in front of the iframe. Swipe is handled by
 *   container-level touch handlers; the cross-origin iframe captures its own
 *   touches, so the player surface is never covered by an overlay element.
 *   App chrome (header, title, mute, nav) sits in flex siblings outside it.
 * - Opening comments unmounts the iframe before rendering CommentSheet; the
 *   contract is never "visible player + sheet overlay".
 * - Opens with muted autoplay (mobile policy allows autoplay only when muted).
 */
export default function ReelViewer({
  videos,
  startIndex,
  teamId = null,
  commentCounts = {},
  onCommentCountChange,
  onClose,
}: ReelViewerProps) {
  const { user } = useAuth();
  const [current, setCurrent] = useState(startIndex);
  const [muted, setMuted] = useState(true); // 뮤트로 시작 (muted여야 autoplay 허용)
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const touchStartY = useRef(0);
  const touchMoved = useRef(false);
  const prevVideoId = useRef(videos[startIndex].id);

  const video = videos[current];
  const videoTeamId = normalizeTeamId(video.teamId ?? teamId);

  // 크보팬 댓글(뉴스 인프라 재사용) — 현재 영상 기준 count/postId resolve.
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [commentPostId, setCommentPostId] = useState<number | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [resolving, setResolving] = useState(false);
  const displayedCommentCount = commentCount ?? commentCounts[video.id] ?? null;

  const postCmd = useCallback((func: string, args: (string | number | boolean)[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }, []);

  const goNext = useCallback(() => {
    if (current < videos.length - 1) setCurrent(c => c + 1);
    setCommentPostId(null);
    setCommentCount(null);
  }, [current, videos.length]);

  const goPrev = useCallback(() => {
    if (current > 0) setCurrent(c => c - 1);
    setCommentPostId(null);
    setCommentCount(null);
  }, [current]);

  const toggleMute = useCallback(() => {
    postCmd(muted ? "unMute" : "mute");
    setMuted(m => !m);
  }, [muted, postCmd]);

  // 스와이프 — 컨테이너 레벨 핸들러(플레이어 위 오버레이 요소 없음).
  const handleTouchStart = (e: React.TouchEvent) => {
    if (commentsOpen) return;
    touchStartY.current = e.touches[0].clientY;
    touchMoved.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (commentsOpen) return;
    if (Math.abs(e.touches[0].clientY - touchStartY.current) > 10) touchMoved.current = true;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (commentsOpen) return;
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
    if (commentsOpen) return;
    if (video.id === prevVideoId.current) return;
    prevVideoId.current = video.id;
    postCmd("loadVideoById", [video.id]);
    if (muted) {
      setTimeout(() => postCmd("mute"), 300);
    }
  }, [commentsOpen, video.id, muted, postCmd]);

  // 댓글 바 탭: 미로그인은 ensure(로그인 게이트) 호출 전 LoginSheet 선노출(generic 실패 회피).
  // 로그인 유저는 discussion resolve → 영상 일시정지 → iframe 언마운트 → CommentSheet 오픈.
  const openComments = useCallback(async () => {
    if (!user) {
      setShowLogin(true);
      return;
    }
    if (resolving) return;
    if (commentPostId !== null) {
      postCmd("pauseVideo");
      setCommentsOpen(true);
      return;
    }
    setResolving(true);
    try {
      const response = await fetch("/api/news/discussion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          youtubeShortsDiscussion({ videoId: video.id, title: video.title, thumbnailUrl: video.thumbnail, teamId: videoTeamId }),
        ),
      });
      if (!response.ok) throw new Error("discussion unavailable");
      const result = (await response.json()) as { postId: number; commentCount: number };
      setCommentPostId(result.postId);
      setCommentCount(result.commentCount);
      onCommentCountChange?.(video.id, result.commentCount);
      postCmd("pauseVideo");
      setCommentsOpen(true);
    } catch {
      alert("댓글을 불러오지 못했어요");
    } finally {
      setResolving(false);
    }
  }, [user, resolving, postCmd, commentPostId, video.id, video.title, video.thumbnail, videoTeamId, onCommentCountChange]);

  const syncCommentCount = useCallback((delta: number) => {
    const next = Math.max(0, (displayedCommentCount ?? 0) + delta);
    setCommentCount(next);
    onCommentCountChange?.(video.id, next);
  }, [displayedCommentCount, onCommentCountChange, video.id]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black flex flex-col"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Header — outside player */}
      <div className="shrink-0 flex items-center justify-between px-4 pt-[env(safe-area-inset-top)] py-3">
        <button onClick={onClose} className="p-2 rounded-full bg-white/10">
          <X size={22} className="text-white" />
        </button>
        <div className="flex items-center gap-2">
          {video.label && (
            <span className="px-2.5 py-1 rounded-full bg-accent/80 text-xs font-semibold text-white">{video.label}</span>
          )}
          <span className="text-white/60 text-xs">{current + 1}/{videos.length}</span>
        </div>
      </div>

      {/* Player region — no overlays on the iframe (YouTube ToS III.C.1). Muted autoplay on open. */}
      <div className="flex-1 min-h-0 flex items-center justify-center bg-black">
        {!commentsOpen && (
          <iframe
            ref={iframeRef}
            src={`https://www.youtube.com/embed/${video.id}?autoplay=1&mute=${muted ? "1" : "0"}&controls=1&rel=0&playsinline=1&enablejsapi=1&origin=${typeof window !== "undefined" ? window.location.origin : ""}`}
            className="w-full h-full"
            style={{ border: "none" }}
            allow="autoplay; encrypted-media"
            allowFullScreen
          />
        )}
      </div>

      {/* Title + actions + nav — outside player */}
      <div className="shrink-0 bg-black px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        <p className="text-white text-sm font-medium line-clamp-2 mb-3">{video.title}</p>
        <div className="flex items-center gap-5">
          <button onClick={toggleMute} disabled={commentsOpen} className="flex items-center gap-1.5 active:scale-95 transition-transform disabled:opacity-40">
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

        {/* 크보팬 댓글 바 — iframe 밖 flex 형제(shrink-0 영역 내). 플레이어 위 오버레이 아님(YouTube ToS). */}
        <button
          type="button"
          onClick={openComments}
          disabled={resolving || commentsOpen}
          className="mt-3 flex w-full items-center gap-2 rounded-xl bg-white/10 px-4 py-3 text-left transition-colors hover:bg-white/15 disabled:opacity-60"
          aria-label={displayedCommentCount != null ? `크보팬 댓글 ${displayedCommentCount}개` : "크보팬 댓글 열기"}
        >
          {resolving ? (
            <Loader2 size={18} className="animate-spin text-accent" />
          ) : (
            <MessageCircle size={18} className="text-accent" />
          )}
          <span className="text-sm font-medium text-white">
            크보팬 댓글{displayedCommentCount ? ` ${displayedCommentCount}` : ""}
          </span>
        </button>
      </div>

      {commentsOpen && commentPostId !== null && (
        <CommentSheet
          isOpen
          onClose={() => setCommentsOpen(false)}
          postId={commentPostId}
          teamId={videoTeamId}
          onCommentAdded={() => syncCommentCount(1)}
          onCommentDeleted={(_postId, removedCount = 1) => syncCommentCount(-removedCount)}
        />
      )}
      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
