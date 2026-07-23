"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X, Volume2, VolumeX, MoreVertical, Loader2, MessageCircle, Send, Trash2 } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import { VENUE_STORY_IMAGE_HOLD_MS, type VenueStory } from "@/lib/venue-stories/types";
import {
  VENUE_STORY_COMMENT_MAX_LENGTH,
  type VenueStoryComment,
} from "@/lib/venue-stories/comments";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";

interface Props {
  stories: VenueStory[];
  startIndex: number;
  currentUserId: string | null;
  onClose: () => void;
  onChanged: () => void; // 삭제/신고 후 목록 갱신
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  return `${hr}시간 전`;
}

export default function VenueStoryViewer({
  stories,
  startIndex,
  currentUserId,
  onClose,
  onChanged,
}: Props) {
  const [index, setIndex] = useState(startIndex);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  // 인스타식 하단 상시 입력바 — 입력 중(포커스)에도 재생 일시정지 (하린아빠 21:22 지시)
  const [inputFocused, setInputFocused] = useState(false);
  const [comments, setComments] = useState<VenueStoryComment[] | null>(null);
  const [commentInput, setCommentInput] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);

  const story = stories[index];

  const goNext = useCallback(() => {
    setIndex((i) => {
      if (i >= stories.length - 1) {
        onClose();
        return i;
      }
      return i + 1;
    });
  }, [stories.length, onClose]);

  const goPrev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // index 바뀔 때 진행 상태 리셋
  useEffect(() => {
    setProgress(0);
    elapsedRef.current = 0;
    startRef.current = performance.now();
    setCommentsOpen(false);
    setComments(null);
    setCommentInput("");
  }, [index]);

  // 스토리별 댓글 로드(개수 표시 + 시트 목록 공용)
  useEffect(() => {
    const storyId = story?.id;
    if (storyId == null) return;
    let cancelled = false;
    fetch(`/api/venue-stories/${storyId}/comments`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data?.comments)) setComments(data.comments);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [story?.id]);

  // 이미지 자동 진행(RAF), 영상은 timeupdate 로 처리
  useEffect(() => {
    if (!story || story.mediaType !== "image") return;
    if (paused || menuOpen || commentsOpen || inputFocused) return;
    const hold = VENUE_STORY_IMAGE_HOLD_MS;
    startRef.current = performance.now();
    const base = elapsedRef.current;
    const tick = () => {
      const el = base + (performance.now() - startRef.current);
      const p = Math.min(1, el / hold);
      setProgress(p);
      if (p >= 1) {
        goNext();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      elapsedRef.current = base + (performance.now() - startRef.current);
    };
  }, [story, index, paused, menuOpen, commentsOpen, inputFocused, goNext]);

  // 영상 재생/일시정지 동기화
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !story || story.mediaType !== "video") return;
    v.muted = muted;
    if (paused || menuOpen || commentsOpen || inputFocused) {
      v.pause();
    } else {
      v.play().catch(() => {
        // 자동재생 차단 시 음소거로 재시도
        v.muted = true;
        setMuted(true);
        v.play().catch(() => {});
      });
    }
  }, [story, index, paused, menuOpen, commentsOpen, inputFocused, muted]);

  const onVideoTime = () => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    setProgress(Math.min(1, v.currentTime / v.duration));
  };

  const handleReport = async () => {
    if (!story) return;
    setBusy(true);
    try {
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        setToast("로그인이 필요해요");
        return;
      }
      const res = await fetch("/api/venue-stories/report", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ storyId: story.id, reason: "부적절한 콘텐츠" }),
      });
      const data = await res.json();
      if (data.error) {
        setToast(data.error);
      } else {
        setToast(data.hidden ? "신고되어 숨김 처리됐어요" : "신고했어요");
        setMenuOpen(false);
        onChanged();
        setTimeout(goNext, 600);
      }
    } catch {
      setToast("신고 실패");
    } finally {
      setBusy(false);
    }
  };

  const handleCommentSubmit = async () => {
    if (!story || commentBusy) return;
    const content = commentInput.trim();
    if (!content) return;
    setCommentBusy(true);
    try {
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        setToast("로그인이 필요해요");
        return;
      }
      const res = await fetch(`/api/venue-stories/${story.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (data.error) {
        setToast(data.error);
      } else if (data.comment) {
        setComments((prev) => [...(prev ?? []), data.comment]);
        setCommentInput("");
      }
    } catch {
      setToast("댓글 작성 실패");
    } finally {
      setCommentBusy(false);
    }
  };

  const handleCommentDelete = async (commentId: number) => {
    if (!story || commentBusy) return;
    setCommentBusy(true);
    try {
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        setToast("로그인이 필요해요");
        return;
      }
      const res = await fetch(`/api/venue-stories/${story.id}/comments/${commentId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) {
        setToast(data.error);
      } else {
        setComments((prev) => (prev ?? []).filter((c) => c.id !== commentId));
      }
    } catch {
      setToast("삭제 실패");
    } finally {
      setCommentBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!story) return;
    setBusy(true);
    try {
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        setToast("로그인이 필요해요");
        return;
      }
      const res = await fetch(`/api/venue-stories/${story.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) {
        setToast(data.error);
      } else {
        setToast("삭제했어요");
        setMenuOpen(false);
        onChanged();
        setTimeout(goNext, 400);
      }
    } catch {
      setToast("삭제 실패");
    } finally {
      setBusy(false);
    }
  };

  if (!story || typeof document === "undefined") return null;
  const isOwn = currentUserId != null && story.userId === currentUserId;

  return createPortal(
    <motion.div
      // 경기 페이지 상단 스코어 헤더가 z-[100]이라 그 위로 — 풀스크린 뷰어는 모든 UI를 덮어야 함
      className="fixed inset-0 z-[120] bg-black flex flex-col select-none"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* 진행바 — iOS 네이티브 상태바(시계/배터리)는 z-index로 못 덮으므로 safe-area 아래로 (삼순 #795 blocker) */}
      <div
        className="absolute top-0 left-0 right-0 z-20 flex gap-1 px-2 pointer-events-none"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)" }}
      >
        {stories.map((s, i) => (
          <div key={s.id} className="flex-1 h-0.5 rounded-full bg-white/30 overflow-hidden">
            <div
              className="h-full bg-white"
              style={{ width: `${i < index ? 100 : i === index ? progress * 100 : 0}%` }}
            />
          </div>
        ))}
      </div>

      {/* 헤더 — 작성자/닫기도 상태바 아래로 */}
      <div
        className="absolute left-0 right-0 z-20 flex items-center gap-2 px-3"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 16px)" }}
      >
        <div className="w-8 h-8 rounded-full bg-white/20 overflow-hidden shrink-0">
          {story.author.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={story.author.avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white text-xs">
              {(story.author.nickname ?? "?").slice(0, 1)}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="text-white text-sm font-semibold truncate">
              {story.author.nickname ?? "익명"}
            </p>
            {(() => {
              const team = story.author.teamId != null ? getTeamById(story.author.teamId) : undefined;
              if (!team) return null;
              return (
                <span
                  className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-bold text-white leading-none"
                  style={{ backgroundColor: getTeamBgColor(team, "dark") }}
                >
                  {team.shortName}
                </span>
              );
            })()}
          </div>
          <p className="text-white/60 text-[11px]">{timeAgo(story.createdAt)}</p>
        </div>
        {story.mediaType === "video" && (
          <button
            onClick={() => setMuted((m) => !m)}
            className="w-9 h-9 flex items-center justify-center text-white/90"
            aria-label="음소거"
          >
            {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          </button>
        )}
        <button
          onClick={() => {
            setMenuOpen(true);
            setPaused(true);
          }}
          className="w-9 h-9 flex items-center justify-center text-white/90"
          aria-label="더보기"
        >
          <MoreVertical size={20} />
        </button>
        <button
          onClick={onClose}
          className="w-9 h-9 flex items-center justify-center text-white/90"
          aria-label="닫기"
        >
          <X size={22} />
        </button>
      </div>

      {/* 미디어 */}
      <div className="flex-1 flex items-center justify-center relative">
        {story.mediaType === "video" ? (
          <video
            ref={videoRef}
            src={story.mediaUrl}
            className="max-h-full max-w-full w-full h-full object-contain"
            playsInline
            autoPlay
            onTimeUpdate={onVideoTime}
            onEnded={goNext}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={story.mediaUrl}
            alt=""
            className="max-h-full max-w-full w-full h-full object-contain"
          />
        )}

        {/* 탭 존: 좌(이전)/우(다음), 길게 눌러 일시정지 */}
        <button
          className="absolute inset-y-0 left-0 w-1/3"
          aria-label="이전"
          onClick={goPrev}
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
          onPointerLeave={() => setPaused(false)}
        />
        <button
          className="absolute inset-y-0 right-0 w-2/3"
          aria-label="다음"
          onClick={goNext}
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
          onPointerLeave={() => setPaused(false)}
        />
      </div>

      {/* 캡션 — 하단 상시 입력바 위로 */}
      {story.caption && (
        <div
          className="absolute left-0 right-0 pl-4 pr-20 z-20 pointer-events-none"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 72px)" }}
        >
          <p className="text-white text-sm bg-black/40 rounded-xl px-3 py-2 inline-block max-w-full break-words">
            {story.caption}
          </p>
        </div>
      )}

      {/* 인스타식 하단 상시 댓글 입력바 (하린아빠 21:22 지시 — 인스타 UI와 동일하게 바로 아래쪽 배치) */}
      <div
        className="absolute left-0 right-0 z-20 flex items-center gap-2 px-3"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
      >
        <input
          value={commentInput}
          onChange={(e) => setCommentInput(e.target.value)}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) handleCommentSubmit();
          }}
          maxLength={VENUE_STORY_COMMENT_MAX_LENGTH}
          placeholder="댓글 달기..."
          className="flex-1 min-w-0 bg-black/40 border border-white/30 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-white/60 outline-none"
        />
        {commentInput.trim().length > 0 ? (
          <button
            onClick={handleCommentSubmit}
            disabled={commentBusy}
            className="w-10 h-10 flex items-center justify-center text-white shrink-0 bg-black/40 rounded-full"
            aria-label="댓글 등록"
          >
            {commentBusy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          </button>
        ) : (
          <button
            onClick={() => setCommentsOpen(true)}
            className="h-10 px-3 flex items-center gap-1.5 text-white/90 bg-black/40 rounded-full shrink-0"
            aria-label="댓글 목록"
          >
            <MessageCircle size={18} />
            <span className="text-sm font-semibold">{comments?.length ?? 0}</span>
          </button>
        )}
      </div>

      {/* 댓글 시트 — 열려있는 동안 재생 일시정지 */}
      {commentsOpen && (
        <div
          className="absolute inset-0 z-30 flex items-end bg-black/50"
          onClick={() => setCommentsOpen(false)}
        >
          <div
            className="w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl flex flex-col max-h-[70%]"
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 pt-4 pb-2 flex items-center justify-between">
              <p className="text-text-primary font-semibold text-sm">
                댓글 {comments?.length ?? 0}
              </p>
              <button
                onClick={() => setCommentsOpen(false)}
                className="w-8 h-8 flex items-center justify-center text-text-secondary"
                aria-label="댓글 닫기"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-1 flex flex-col gap-3 min-h-24">
              {comments == null ? (
                <div className="flex justify-center py-6">
                  <Loader2 size={18} className="animate-spin text-text-secondary" />
                </div>
              ) : comments.length === 0 ? (
                <p className="text-text-secondary text-sm text-center py-6">
                  첫 댓글을 남겨보세요
                </p>
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="flex items-start gap-2">
                    <div className="w-7 h-7 rounded-full bg-white/10 overflow-hidden shrink-0">
                      {c.author.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.author.avatarUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-text-secondary text-[10px]">
                          {(c.author.nickname ?? "?").slice(0, 1)}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-text-secondary text-[11px]">
                        {c.author.nickname ?? "익명"} · {timeAgo(c.createdAt)}
                      </p>
                      <p className="text-text-primary text-sm break-words">{c.content}</p>
                    </div>
                    {currentUserId != null && c.userId === currentUserId && (
                      <button
                        onClick={() => handleCommentDelete(c.id)}
                        disabled={commentBusy}
                        className="w-7 h-7 flex items-center justify-center text-text-secondary shrink-0"
                        aria-label="댓글 삭제"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="px-4 py-3 flex items-center gap-2 border-t border-white/5">
              <input
                value={commentInput}
                onChange={(e) => setCommentInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) handleCommentSubmit();
                }}
                maxLength={VENUE_STORY_COMMENT_MAX_LENGTH}
                placeholder="댓글 달기..."
                className="flex-1 bg-white/5 rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-secondary outline-none"
              />
              <button
                onClick={handleCommentSubmit}
                disabled={commentBusy || commentInput.trim().length === 0}
                className="w-9 h-9 flex items-center justify-center text-accent disabled:text-text-secondary"
                aria-label="댓글 등록"
              >
                {commentBusy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 액션 시트 */}
      {menuOpen && (
        <div
          className="absolute inset-0 z-30 flex items-end bg-black/50"
          onClick={() => {
            setMenuOpen(false);
            setPaused(false);
          }}
        >
          <div
            className="w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl p-4 pb-8 flex flex-col gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            {isOwn ? (
              <button
                onClick={handleDelete}
                disabled={busy}
                className="w-full py-3 rounded-xl bg-red-500/15 text-red-400 font-semibold flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : null} 삭제하기
              </button>
            ) : (
              <button
                onClick={handleReport}
                disabled={busy}
                className="w-full py-3 rounded-xl bg-red-500/15 text-red-400 font-semibold flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : null} 신고하기
              </button>
            )}
            <button
              onClick={() => {
                setMenuOpen(false);
                setPaused(false);
              }}
              className="w-full py-3 rounded-xl bg-white/5 text-text-secondary"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="absolute bottom-24 left-0 right-0 z-40 flex justify-center pointer-events-none">
          <div className="bg-black/80 text-white text-sm px-4 py-2 rounded-full">{toast}</div>
        </div>
      )}
    </motion.div>,
    document.body,
  );
}
