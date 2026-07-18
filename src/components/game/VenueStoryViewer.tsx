"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X, Volume2, VolumeX, MoreVertical, Loader2 } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import { VENUE_STORY_IMAGE_HOLD_MS, type VenueStory } from "@/lib/venue-stories/types";

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
  }, [index]);

  // 이미지 자동 진행(RAF), 영상은 timeupdate 로 처리
  useEffect(() => {
    if (!story || story.mediaType !== "image") return;
    if (paused || menuOpen) return;
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
  }, [story, index, paused, menuOpen, goNext]);

  // 영상 재생/일시정지 동기화
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !story || story.mediaType !== "video") return;
    v.muted = muted;
    if (paused || menuOpen) {
      v.pause();
    } else {
      v.play().catch(() => {
        // 자동재생 차단 시 음소거로 재시도
        v.muted = true;
        setMuted(true);
        v.play().catch(() => {});
      });
    }
  }, [story, index, paused, menuOpen, muted]);

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
      className="fixed inset-0 z-[60] bg-black flex flex-col select-none"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* 진행바 */}
      <div className="absolute top-0 left-0 right-0 z-20 flex gap-1 px-2 pt-2 pointer-events-none">
        {stories.map((s, i) => (
          <div key={s.id} className="flex-1 h-0.5 rounded-full bg-white/30 overflow-hidden">
            <div
              className="h-full bg-white"
              style={{ width: `${i < index ? 100 : i === index ? progress * 100 : 0}%` }}
            />
          </div>
        ))}
      </div>

      {/* 헤더 */}
      <div className="absolute top-4 left-0 right-0 z-20 flex items-center gap-2 px-3">
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
          <p className="text-white text-sm font-semibold truncate">
            {story.author.nickname ?? "익명"}
          </p>
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

      {/* 캡션 */}
      {story.caption && (
        <div className="absolute bottom-6 left-0 right-0 px-4 z-20 pointer-events-none">
          <p className="text-white text-sm bg-black/40 rounded-xl px-3 py-2 inline-block max-w-full break-words">
            {story.caption}
          </p>
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
