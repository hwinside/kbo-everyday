"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X, Volume2, VolumeX, MoreVertical, Loader2, MessageCircle, Send, Trash2 } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import { VENUE_STORY_IMAGE_HOLD_MS, type VenueStory } from "@/lib/venue-stories/types";
import {
  VENUE_STORY_COMMENT_MAX_LENGTH,
  scrollToLatest,
  shouldApplyCommentResponse,
  type VenueStoryComment,
} from "@/lib/venue-stories/comments";
import { subscribeKeyboardInset } from "@/lib/venue-stories/keyboard-inset";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";

interface Props {
  stories: VenueStory[];
  startIndex: number;
  currentUserId: string | null;
  onStorySeen?: (storyId: string | number) => void; // 표시된 스토리 본 처리 (트레이 본/안 본 구분용)
  onClose: () => void;
  onChanged: () => void; // 삭제/신고 후 목록 갱신
}

// 댓글 아바타 — 외부 호스트(카카오/구글 CDN 등) 핫링크 차단으로 깨질 때
// referrerPolicy=no-referrer + onError 이니셜 폴백 (삼순 #807 blocker — 댓글 영역 전용,
// 뷰어 헤더 아바타는 #805에서 별도 처리)
function CommentAvatar({
  avatarUrl,
  nickname,
  className,
  initialClassName,
}: {
  avatarUrl: string | null;
  nickname: string | null;
  className: string;
  initialClassName: string;
}) {
  const initial = (nickname ?? "?").slice(0, 1);
  return (
    <div className={className}>
      {avatarUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={avatarUrl}
            alt=""
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
            onError={(e) => {
              e.currentTarget.classList.add("hidden");
              const fallback = e.currentTarget.nextElementSibling;
              if (fallback) {
                fallback.classList.remove("hidden");
                fallback.classList.add("flex");
              }
            }}
          />
          <div className={`hidden w-full h-full items-center justify-center ${initialClassName}`}>
            {initial}
          </div>
        </>
      ) : (
        <div className={`flex w-full h-full items-center justify-center ${initialClassName}`}>
          {initial}
        </div>
      )}
    </div>
  );
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
  onStorySeen,
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
  const [commentTotal, setCommentTotal] = useState<number | null>(null);
  const [commentInput, setCommentInput] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  // iOS 키보드 회피 — CommentSheet 와 동일한 state 기반 visualViewport 패턴.
  // iOS Safari/WKWebView 는 키보드가 떠도 레이아웃 뷰포트가 그대로라
  // absolute bottom+safe-area 만으로는 컴포저가 키보드에 덮인다 →
  // 시각 뷰포트 차이(kbInset)를 state 로 끌어와 bottom 에 더해준다.
  const [kbInset, setKbInset] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  // 전송 중 스토리 전환 오염 방지(삼순 #807 라운드3 blocker 3) — 현재 보이는 story id.
  // POST 응답 도착 시 요청 시점에 캡처한 id 와 비교해 불일치면 반영을 스킵한다.
  const storyIdRef = useRef<number | null>(null);
  // 탭 순간 nav 잠금 여부 캡처 — pointerdown 은 input blur 보다 먼저 오므로
  // 포커스 중 탭은 키보드만 닫고 이동은 막는다(blur 후 click 시점엔 state 가 풀려 있음).
  const navSuppressRef = useRef(false);
  // 최신 댓글 bottom scroll 대상 — 포커스 오버레이/댓글 시트 목록 컨테이너
  const overlayListRef = useRef<HTMLDivElement>(null);
  const sheetListRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);

  const story = stories[index];

  // #807 전송 중 스토리 전환 오염 가드용 현재 story.id 추적
  const storyId = story?.id;
  useEffect(() => {
    storyIdRef.current = storyId ?? null;
  }, [storyId]);

  // #809 표시된 스토리는 본 처리 (트레이 본/안 본 테두리·정렬용)
  useEffect(() => {
    if (storyId != null) onStorySeen?.(storyId);
  }, [storyId, onStorySeen]);

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
    setCommentTotal(null);
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
        if (!cancelled && Array.isArray(data?.comments)) {
          setComments(data.comments);
          setCommentTotal(
            typeof data.total === "number" ? data.total : data.comments.length,
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [story?.id]);

  // 뷰어 열린 동안 body 스크롤 잠금 — iOS에서 댓글 키보드를 띄우고 스크롤하면 배경(문서)이
  // 영상과 함께 밀려 스크롤되던 문제 방지(하린아빠 A17 리포트). 컨테이너 overscroll-contain 과 병행.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // 키보드 회피 — 입력바 포커스/댓글 시트가 열려 있을 때만 구독(CommentSheet 패턴 재사용).
  // 계산/구독은 keyboard-inset.ts 순수 헬퍼 — 스모크가 모킹 visualViewport 로 회귀 검증(삼순 #807 blocker 4)
  useEffect(() => {
    if (!inputFocused && !commentsOpen) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const unsubscribe = subscribeKeyboardInset(
      vv,
      () => window.innerHeight,
      setKbInset,
    );
    return () => {
      unsubscribe();
      setKbInset(0);
    };
  }, [inputFocused, commentsOpen]);

  // 최신 댓글 bottom scroll(삼순 #807 blocker 5) — 정순(오래된→최신) 렌더라
  // 오버레이/시트가 열릴 때·댓글이 로드/추가될 때 최신 댓글이 보이도록 맨 아래로.
  useEffect(() => {
    if (inputFocused) scrollToLatest(overlayListRef.current);
    if (commentsOpen) scrollToLatest(sheetListRef.current);
  }, [inputFocused, commentsOpen, comments]);

  // 이미지 자동 진행(RAF), 영상은 timeupdate 로 처리
  useEffect(() => {
    if (!story || story.mediaType !== "image") return;
    // commentBusy: 전송 중 blur 로 inputFocused 가 먼저 풀려도 재생이 재개되지 않게 결속
    if (paused || menuOpen || commentsOpen || inputFocused || commentBusy) return;
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
  }, [story, index, paused, menuOpen, commentsOpen, inputFocused, commentBusy, goNext]);

  // 영상 재생/일시정지 동기화
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !story || story.mediaType !== "video") return;
    v.muted = muted;
    if (paused || menuOpen || commentsOpen || inputFocused || commentBusy) {
      v.pause();
    } else {
      v.play().catch(() => {
        // 자동재생 차단 시 음소거로 재시도
        v.muted = true;
        setMuted(true);
        v.play().catch(() => {});
      });
    }
  }, [story, index, paused, menuOpen, commentsOpen, inputFocused, commentBusy, muted]);

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
    // 요청 시점 story id 캡처 — 응답 도착 시 다른 스토리로 전환돼 있으면 반영 스킵
    const submitStoryId = story.id;
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
        // A 스토리 submit → B 로 전환 → A 응답 도착 시 B 목록 오염 방지
        if (shouldApplyCommentResponse(submitStoryId, storyIdRef.current)) {
          setComments((prev) => [...(prev ?? []), data.comment]);
          setCommentTotal((prev) => (prev ?? 0) + 1);
          setCommentInput("");
        }
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
        setCommentTotal((prev) => Math.max(0, (prev ?? 1) - 1));
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
      className="fixed inset-0 z-[120] bg-black flex flex-col select-none overflow-hidden overscroll-none"
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
        {/* story.id key로 remount — 이전 스토리에서 onError로 숨긴 img/flex 폴백이 다음 스토리에 남지 않게 (삼순 #805) */}
        <div key={`avatar-${story.id}`} className="w-8 h-8 rounded-full bg-white/20 overflow-hidden shrink-0">
          {story.author.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={story.author.avatarUrl}
              alt=""
              className="w-full h-full object-cover"
              // 구글 프로필 이미지는 referrer 달리면 403 → 깨진 아이콘 (NewsCarousel과 동일 패턴)
              referrerPolicy="no-referrer"
              // 로드 실패 시 깨진 이미지 대신 이니셜 폴백
              onError={(e) => {
                const img = e.currentTarget;
                img.style.display = "none";
                const fb = img.parentElement?.querySelector("[data-avatar-fallback]");
                // hidden 제거만 하면 flex가 안 붙어 이니셜이 안 보임 → flex도 명시적으로 추가 (삼순 #805)
                fb?.classList.remove("hidden");
                fb?.classList.add("flex");
              }}
            />
          ) : null}
          <div
            data-avatar-fallback
            className={`w-full h-full items-center justify-center text-white text-xs ${story.author.avatarUrl ? "hidden" : "flex"}`}
          >
            {(story.author.nickname ?? "?").slice(0, 1)}
          </div>
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

        {/* 탭 존: 좌(이전)/우(다음), 길게 눌러 일시정지.
            전송 중(commentBusy)·입력 포커스 중엔 이동 비활성(삼순 #807 라운드3 blocker 3) —
            pointerdown(blur 이전) 시점의 잠금을 캡처해 click 에서 이동을 스킵한다. */}
        <button
          className="absolute inset-y-0 left-0 w-1/3"
          aria-label="이전"
          onClick={() => {
            if (navSuppressRef.current || commentBusy) {
              navSuppressRef.current = false;
              return;
            }
            goPrev();
          }}
          onPointerDown={() => {
            navSuppressRef.current = commentBusy || inputFocused;
            setPaused(true);
          }}
          onPointerUp={() => setPaused(false)}
          onPointerLeave={() => setPaused(false)}
        />
        <button
          className="absolute inset-y-0 right-0 w-2/3"
          aria-label="다음"
          onClick={() => {
            if (navSuppressRef.current || commentBusy) {
              navSuppressRef.current = false;
              return;
            }
            goNext();
          }}
          onPointerDown={() => {
            navSuppressRef.current = commentBusy || inputFocused;
            setPaused(true);
          }}
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

      {/* 입력창 포커스 시 기존 댓글을 입력바 위에 오버레이 (하린아빠 21:45 지시 — 인스타 DM과 달리 우리는 댓글을 보여줌) */}
      {inputFocused && (
        <div
          className="absolute left-0 right-0 z-20 px-3 flex flex-col justify-end"
          style={{
            bottom: `calc(env(safe-area-inset-bottom, 0px) + ${64 + kbInset}px)`,
            maxHeight: "38%",
          }}
          // 오버레이 터치로 입력 blur 되지 않게 (스크롤 중 오버레이가 사라지는 것 방지)
          onMouseDown={(e) => e.preventDefault()}
        >
          <div ref={overlayListRef} className="overflow-y-auto flex flex-col gap-2 py-1">
            {comments == null ? (
              <div className="flex justify-center py-2">
                <Loader2 size={16} className="animate-spin text-white/70" />
              </div>
            ) : comments.length === 0 ? (
              <p className="text-white/70 text-xs bg-black/40 rounded-full px-3 py-1.5 self-start">
                첫 댓글을 남겨보세요
              </p>
            ) : (
              comments.map((c) => (
                <div key={c.id} className="flex items-start gap-2 max-w-[85%]">
                  <CommentAvatar
                    avatarUrl={c.author.avatarUrl}
                    nickname={c.author.nickname}
                    className="w-6 h-6 rounded-full bg-white/20 overflow-hidden shrink-0"
                    initialClassName="text-white text-[10px]"
                  />
                  <div className="bg-black/45 rounded-2xl px-3 py-1.5 min-w-0">
                    <p className="text-white/70 text-[10px] leading-tight">
                      {c.author.nickname ?? "익명"} · {timeAgo(c.createdAt)}
                    </p>
                    <p className="text-white text-[13px] break-words">{c.content}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* iOS 키보드-입력바 사이 gap으로 뒤 경기화면이 비치던 문제 방지(하린아빠 A17 리포트).
          body scroll lock이 주 방어고, 이 opaque 백드롭은 입력바 아래~화면바닥을 검정으로 확실히 메운다. */}
      {(inputFocused || commentsOpen) && (
        <div
          className="absolute inset-x-0 bottom-0 z-[15] bg-black pointer-events-none"
          style={{ height: `calc(env(safe-area-inset-bottom, 0px) + ${kbInset + 60}px)` }}
          aria-hidden
        />
      )}

      {/* 인스타식 하단 상시 댓글 입력바 (하린아빠 21:22 지시 — 인스타 UI와 동일하게 바로 아래쪽 배치).
          data-composer 는 iOS 실기기 키보드 QA(browserstack-ios-story-comments-keyboard.mjs) 마커. */}
      <div
        data-composer="venue-story"
        className="absolute left-0 right-0 z-20 flex items-center gap-2 px-3"
        style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + ${12 + kbInset}px)` }}
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
            <span className="text-sm font-semibold">{commentTotal ?? 0}</span>
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
            style={{ paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + ${kbInset}px)` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 pt-4 pb-2 flex items-center justify-between">
              <p className="text-text-primary font-semibold text-sm">
                댓글 {commentTotal ?? 0}
              </p>
              <button
                onClick={() => setCommentsOpen(false)}
                className="w-8 h-8 flex items-center justify-center text-text-secondary"
                aria-label="댓글 닫기"
              >
                <X size={18} />
              </button>
            </div>
            <div
              ref={sheetListRef}
              className="flex-1 overflow-y-auto px-4 py-1 flex flex-col gap-3 min-h-24"
            >
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
                    <CommentAvatar
                      avatarUrl={c.author.avatarUrl}
                      nickname={c.author.nickname}
                      className="w-7 h-7 rounded-full bg-white/10 overflow-hidden shrink-0"
                      initialClassName="text-text-secondary text-[10px]"
                    />
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
