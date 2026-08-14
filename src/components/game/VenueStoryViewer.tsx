"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X, Volume2, VolumeX, MoreVertical, Loader2, MessageCircle, Send, Trash2, Eye } from "lucide-react";
import AdminOnly from "@/components/admin/AdminOnly";
import { getSafeSession } from "@/lib/supabase/client";
import { VENUE_STORY_IMAGE_HOLD_MS, type VenueStory } from "@/lib/venue-stories/types";
import {
  VENUE_STORY_COMMENT_MAX_LENGTH,
  scrollToLatest,
  shouldApplyCommentResponse,
  type VenueStoryComment,
} from "@/lib/venue-stories/comments";
import {
  computeKeyboardInset,
  isVenueStoryKeyboardOpen,
} from "@/lib/venue-stories/keyboard-inset";
import { shouldCloseCommentSheetDrag } from "@/lib/venue-stories/comment-sheet-gesture";
import {
  createPressState,
  markPressStart,
  cancelPress,
  shouldSubmitOnPointerUp,
  canBeginCommentSubmit,
} from "@/lib/venue-stories/comment-submit-gesture";
import {
  safeBottomCalc,
  STORY_NAV_BOTTOM_OFFSET,
  STORY_PILL_BOTTOM_OFFSET,
  STORY_CAPTION_BOTTOM_OFFSET,
} from "@/lib/venue-stories/story-tap-zone";
import { lockRootScroll, unlockRootScroll } from "@/lib/venue-stories/scroll-lock";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { isIosNativeRuntime } from "@/lib/capacitor/platform";
import { startVenueStoryUrlRefresh } from "@/lib/venue-stories/refresh-policy";
import { getAvatarPath } from "@/lib/constants/avatars";
import { trackVenueStoryView } from "@/lib/venue-stories/view-tracker-client";
import { postViewTotal } from "@/lib/community/view-tracker-policy";

interface Props {
  stories: VenueStory[];
  startIndex: number;
  currentUserId: string | null;
  onStorySeen?: (storyId: string | number) => void; // 표시된 스토리 본 처리 (트레이 본/안 본 구분용)
  onRefreshUrl?: (storyId: number, controller: AbortController) => Promise<boolean>;
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
  // 아바타는 `preset:xxx`/`custom:https://...` 형식으로 저장된다 — 날것 src 로 넣으면
  // 로드 실패해 이니셜만 보인다(하린아빠 7/29 프로필 이미지 안뜸 리포트). 커뮤니티
  // CommentSheet 와 동일하게 getAvatarPath 로 실제 경로/URL 로 해석한다.
  const resolvedAvatar = getAvatarPath(avatarUrl);
  return (
    <div className={className}>
      {resolvedAvatar ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={resolvedAvatar}
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
  onRefreshUrl,
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
  // 댓글 모달(바텀시트) 오픈 여부 — 인라인 입력바 대신 탭→모달 방식(하린아빠 7/25 지시).
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsClosing, setCommentsClosing] = useState(false);
  const [comments, setComments] = useState<VenueStoryComment[] | null>(null);
  const [commentTotal, setCommentTotal] = useState<number | null>(null);
  const [commentInput, setCommentInput] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  // 모달 컴포저 포커스 → 시트를 시각 뷰포트 전체 높이로 확장(CommentSheet expanded 패턴).
  const [composerFocused, setComposerFocused] = useState(false);
  // iOS 키보드 회피 — CommentSheet 와 동일한 state 기반 visualViewport 패턴.
  // iOS Safari/WKWebView 는 키보드가 떠도 레이아웃 뷰포트가 그대로라 absolute bottom+safe-area
  // 만으로는 컴포저가 키보드에 덮인다 → 시각 뷰포트 차이(kbInset)로 시트 바닥을 키보드 위로 올리고
  // (bottom=kbInset) 확장 높이를 시각 뷰포트(vvHeight)로 잡아 목록+컴포저가 키보드 위에 함께 보이게 한다.
  const [kbInset, setKbInset] = useState(0);
  const [vvHeight, setVvHeight] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  // 전송 중 스토리 전환 오염 방지(삼순 #807 라운드3 blocker 3) — 현재 보이는 story id.
  // POST 응답 도착 시 요청 시점에 캡처한 id 와 비교해 불일치면 반영을 스킵한다.
  const storyIdRef = useRef<number | null>(null);
  // 최신 댓글 bottom scroll 대상 — 댓글 시트 목록 컨테이너
  const sheetListRef = useRef<HTMLDivElement>(null);
  const commentDragStartXRef = useRef(0);
  const commentDragStartYRef = useRef(0);
  const commentDragShouldCloseRef = useRef(false);
  // 전송 재진입 가드(동기) — pointerup 제출 뒤 따라오는 trailing click 이 같은 탭에서 중복 POST
  // 하지 않게 동기 ref 로 막는다(commentBusy 는 setState 라 같은 탭 내 stale).
  const commentSubmitLockRef = useRef(false);
  // 전송 버튼 press 상태 — pointerdown 에서 시작, primary pointerup(버튼 위)에서만 제출 확정.
  const commentPressRef = useRef(createPressState());
  // 스토리 좌/우 탭은 pointerup에서 즉시 1칸 이동한다.
  // pointer 뒤 합성 click(detail>0)은 무시하고 키보드 click(detail=0)만 폴백으로 받아 2칸 이동을 막는다.
  const storyNavPressRef = useRef(createPressState());
  // 뷰어 크롬 버튼(음소거/더보기/닫기/댓글 pill) — iPhone 실기기에서 click 합성이 첫 탭을 씹어
  // 더블탭을 요구(하린아빠 8/13·8/14 리포트, WAAPI 전환 #1178 후에도 재현 지속).
  // 좌/우 넘기기 존·댓글 전송 버튼(#948)과 동일하게 click 대신 primary pointerup(버튼 안 릴리즈)에서
  // 확정한다 — pointer 이벤트는 이 뷰어에서 첫 탭부터 안정적임이 실증된 경로.
  // onClick 은 키보드(detail=0) 폴백만 받고 pointer 합성 click(detail>0)은 무시해 중복 발동을 막는다.
  const chromePressRefs = useRef({
    mute: createPressState(),
    more: createPressState(),
    close: createPressState(),
    comments: createPressState(),
  });
  const chromePressHandlers = (
    key: "mute" | "more" | "close" | "comments",
    activate: () => void,
  ) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      // 포커스/선택 등 기본동작 억제 + iOS 합성 click 경로 의존 제거(넘기기 존과 동일 계약)
      e.preventDefault();
      markPressStart(chromePressRefs.current[key]);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const b = e.currentTarget.getBoundingClientRect();
      const shouldActivate = shouldSubmitOnPointerUp(chromePressRefs.current[key], {
        isPrimary: e.isPrimary,
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
        bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      });
      if (shouldActivate) activate();
    },
    onPointerCancel: () => cancelPress(chromePressRefs.current[key]),
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
      // 키보드 접근성(Enter/Space, detail=0)만 폴백 — pointer 합성 click 은 중복 발동 방지
      if (e.detail === 0) activate();
    },
  });
  // 이미지 진행바 — RAF+setState(초당 60회 리렌더) 대신 Web Animations API 로 compositor 구동.
  // iOS WebKit 은 탭 디스패치 창에서 스크립트발 DOM/style 변이를 감지하면 첫 탭을 hover 로
  // 삼켜 click 을 안 보낸다(더블탭 요구) — 하린아빠 8/13 iPhone 리포트: 댓글/더보기/닫기 전부
  // 더블탭. WAAPI/CSS 애니메이션은 엔진 구동이라 이 휴리스틱에 걸리지 않는다.
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const progressAnimRef = useRef<{ storyId: number; anim: Animation } | null>(null);
  const refreshedStoryIdRef = useRef<number | null>(null);
  const lastUrlRefreshAtRef = useRef(0);

  const story = stories[index];
  const keyboardOpen = isVenueStoryKeyboardOpen(composerFocused, kbInset);

  // #807 전송 중 스토리 전환 오염 가드용 현재 story.id 추적
  const storyId = story?.id;
  useEffect(() => {
    storyIdRef.current = storyId ?? null;
  }, [storyId]);

  // #809 표시된 스토리는 본 처리 (트레이 본/안 본 테두리·정렬용)
  useEffect(() => {
    if (storyId != null) onStorySeen?.(storyId);
  }, [storyId, onStorySeen]);

  // 조회수 트래킹(A안 원문 · #735 패턴) — 뷰어 열람 = click: 표시된 스토리마다 1회 전송.
  // 비로그인 guest 집계·beacon 우선/keepalive 폴백·탭 세션 내 중복 방지·실패 재시도 해제는
  // trackVenueStoryView(view-tracker-client)가 담당. 스토리×뷰어×kind×KST일 dedupe 는 서버 RPC 보장.
  useEffect(() => {
    if (storyId == null || storyId <= 0) return;
    void trackVenueStoryView(storyId, "click");
  }, [storyId]);

  // 목록 최초 발급 URL의 나이를 신뢰하지 않고 현재 스토리 진입 즉시 단건 재발급한다.
  // 순수·주입형 루프(startVenueStoryUrlRefresh)를 그대로 사용해 테스트가 동일 코드를 실행한다.
  useEffect(() => {
    if (storyId == null || storyId <= 0 || !onRefreshUrl) return;
    const refresh = onRefreshUrl;
    return startVenueStoryUrlRefresh({
      storyId,
      isCurrentStory: () => storyIdRef.current === storyId,
      refresh,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle),
      getPreviousStoryId: () => refreshedStoryIdRef.current,
      setPreviousStoryId: (value) => {
        refreshedStoryIdRef.current = value;
      },
      getLastRefreshAt: () => lastUrlRefreshAtRef.current,
      setLastRefreshAt: (value) => {
        lastUrlRefreshAtRef.current = value;
      },
    });
  }, [storyId, onRefreshUrl]);

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
    setCommentsOpen(false);
    setCommentsClosing(false);
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

  // 뷰어 열린 동안 root scroll 완전 잠금 — iOS WKWebView 는 키보드가 열린 상태의 native drag 가
  // document/root(body·html)를 움직여 배경 경기방과 fixed viewer 가 함께 밀린다(하린아빠 iOS 리포트).
  // body overflow:hidden 만으론 부족해 scrollY 저장 + position:fixed 로 root scroll 자체를 막고
  // 해제 시 원위치 복원한다(scroll-lock.ts 순수 헬퍼, 회귀로 고정 — 삼순 #839 blocker 3).
  //
  // ⚠️ 단, 댓글 모달이 열린 동안에는 viewer 전용 강제 scroll-restore(visualViewport.scroll → window.scrollTo)를
  // 억제한다. 이 강제 복원 루프가 키보드 열린 상태에서 매 visualViewport.scroll 마다 window.scrollTo 를 반복
  // 호출해 실기기에서 모달 진동(지터)을 만들었다(하린아빠 7/26 iOS). 기사 CommentSheet 는 이 루프 없이 body
  // position:fixed modal lock 만으로 정상 동작 → 댓글 열린 중엔 CommentSheet 와 동일 semantics 로 전환한다
  // (배경 위치 복원은 body position:fixed(top:-scrollY)로 그대로 보존). commentsOpenRef 로 최신값을 읽는다.
  const commentsOpenRef = useRef(false);
  useEffect(() => {
    commentsOpenRef.current = commentsOpen;
  }, [commentsOpen]);
  useEffect(() => {
    const saved = lockRootScroll(() => commentsOpenRef.current);
    return () => {
      unlockRootScroll(saved);
    };
  }, []);

  // 키보드 회피 — 댓글 모달이 열려 있을 때만 visualViewport 를 구독한다.
  // computeKeyboardInset(순수·스모크 회귀)로 인셋을, vv.height 로 확장 높이를 state 로 끌어온다
  // (CommentSheet 와 동일한 bottom=kbInset / height=vvHeight 패턴).
  useEffect(() => {
    if (!commentsOpen) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      setKbInset(computeKeyboardInset(window.innerHeight, vv.height, vv.offsetTop));
      setVvHeight(vv.height);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      setKbInset(0);
      setVvHeight(null);
      setComposerFocused(false);
    };
  }, [commentsOpen]);

  // 최신 댓글 bottom scroll(삼순 #807 blocker 5) — 정순(오래된→최신) 렌더라
  // 시트가 열릴 때·댓글이 로드/추가될 때·확장될 때 최신 댓글이 보이도록 맨 아래로.
  useEffect(() => {
    if (commentsOpen) scrollToLatest(sheetListRef.current);
  }, [commentsOpen, comments, composerFocused]);

  const requestCommentsClose = useCallback(() => {
    setCommentsClosing(true);
  }, []);

  const handleCommentSheetTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    commentDragStartXRef.current = e.touches[0].clientX;
    commentDragStartYRef.current = e.touches[0].clientY;
    commentDragShouldCloseRef.current = false;
  }, []);

  const handleCommentSheetTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    const target = e.target;
    if (!(target instanceof HTMLElement) || target.closest("input, textarea")) return;
    const deltaX = Math.abs(e.touches[0].clientX - commentDragStartXRef.current);
    const deltaY = e.touches[0].clientY - commentDragStartYRef.current;
    if (deltaY < 18 || deltaY < deltaX * 1.2) return;
    const scrollEl = target.closest("[data-comment-scroll='true']") as HTMLElement | null;
    if (scrollEl && scrollEl.scrollTop > 2) return;
    commentDragShouldCloseRef.current = true;
    if (e.cancelable) e.preventDefault();
  }, []);

  const handleCommentSheetTouchEnd = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.changedTouches[0];
    if (!touch) return;
    const deltaX = Math.abs(touch.clientX - commentDragStartXRef.current);
    const deltaY = touch.clientY - commentDragStartYRef.current;
    const shouldClose = shouldCloseCommentSheetDrag({
      armed: commentDragShouldCloseRef.current,
      deltaX,
      deltaY,
    });
    commentDragShouldCloseRef.current = false;
    if (shouldClose) requestCommentsClose();
  }, [requestCommentsClose]);

  // 이미지 자동 진행 — WAAPI(엔진 구동, per-frame 스크립트 변이 0). 영상은 timeupdate 로 처리.
  // 일시정지는 anim.pause()(currentTime 보존 — display:none 이 돼도 CSS 애니메이션과 달리 리셋 없음).
  useEffect(() => {
    if (!story || story.mediaType !== "image") return;
    const el = progressBarRef.current;
    // jsdom 등 WAAPI 미지원 환경은 자동 진행 없이 뷰어만 유지(수동 넘김은 동작)
    if (!el || typeof el.animate !== "function") return;
    let entry = progressAnimRef.current;
    if (!entry || entry.storyId !== story.id) {
      entry?.anim.cancel();
      const anim = el.animate(
        [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: VENUE_STORY_IMAGE_HOLD_MS, easing: "linear", fill: "forwards" },
      );
      entry = { storyId: story.id, anim };
      progressAnimRef.current = entry;
    }
    entry.anim.onfinish = () => goNext();
    // commentBusy: 전송 중에는 모달이 닫혀도 재생이 재개되지 않게 결속(기존 계약 유지)
    if (paused || menuOpen || commentsOpen || commentBusy) entry.anim.pause();
    else entry.anim.play();
  }, [story, index, paused, menuOpen, commentsOpen, commentBusy, goNext]);

  // 스토리 전환/뷰어 unmount 시 잔여 애니메이션 정리 — fill:forwards 가 남으면
  // 이전 바의 inline width(100%/0%) 스타일을 애니메이션 결과가 계속 덮는다.
  useEffect(() => {
    return () => {
      progressAnimRef.current?.anim.cancel();
      progressAnimRef.current = null;
    };
  }, [index]);

  // 영상 재생/일시정지 동기화
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !story || story.mediaType !== "video") return;
    v.muted = muted;
    if (paused || menuOpen || commentsOpen || commentBusy) {
      v.pause();
    } else {
      v.play().catch(() => {
        // 자동재생 차단 시 음소거로 재시도
        v.muted = true;
        setMuted(true);
        v.play().catch(() => {});
      });
    }
  }, [story, index, paused, menuOpen, commentsOpen, commentBusy, muted]);

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
    const content = commentInput.trim();
    if (
      !canBeginCommentSubmit({
        hasStory: !!story,
        hasContent: content.length > 0,
        busy: commentBusy,
        locked: commentSubmitLockRef.current,
      })
    ) {
      return;
    }
    if (!story) return; // 타입 내로잉(위 hasStory 로 이미 보장)
    // 요청 시점 story id 캡처 — 응답 도착 시 다른 스토리로 전환돼 있으면 반영 스킵
    const submitStoryId = story.id;
    commentSubmitLockRef.current = true;
    setCommentBusy(true);
    setCommentError(null);
    try {
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        setCommentError("로그인이 필요해요");
        return;
      }
      const res = await fetch(`/api/venue-stories/${story.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (data.error) {
        setCommentError(data.error);
      } else if (data.comment) {
        // A 스토리 submit → B 로 전환 → A 응답 도착 시 B 목록 오염 방지
        if (shouldApplyCommentResponse(submitStoryId, storyIdRef.current)) {
          setComments((prev) => [...(prev ?? []), data.comment]);
          setCommentTotal((prev) => (prev ?? 0) + 1);
          setCommentInput("");
        }
      }
    } catch {
      setCommentError("댓글 작성 실패");
    } finally {
      commentSubmitLockRef.current = false;
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

  const handleStoryNavPointerUp = (
    direction: "prev" | "next",
    e: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    const shouldNavigate = shouldSubmitOnPointerUp(storyNavPressRef.current, {
      isPrimary: e.isPrimary,
      button: e.button,
      clientX: e.clientX,
      clientY: e.clientY,
      bounds: {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
      },
    });
    setPaused(false);
    if (!shouldNavigate || commentBusy) return;
    if (direction === "prev") goPrev();
    else goNext();
  };

  const handleStoryNavClick = (direction: "prev" | "next", detail: number) => {
    if (detail > 0 || commentBusy) return;
    if (direction === "prev") goPrev();
    else goNext();
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
  // iOS 원격로드 WKWebView 에서만 env(safe-area-inset-top)이 0으로 깨져 최소 44px 폴백이 필요하다.
  // Android·웹/PWA는 env() 순수값 유지(삼순 #843 NO-GO — 전 플랫폼 44px 강제 회귀 방지).
  // 원격 로드 설치 앱은 core 가 'web' false-negative 될 수 있어 주입 브릿지까지 보는 런타임 판정 사용(#484/#833).
  const safeAreaInsetTop = isIosNativeRuntime()
    ? "max(env(safe-area-inset-top, 0px), 44px)"
    : "env(safe-area-inset-top, 0px)";

  return createPortal(
    <motion.div
      data-venue-story-viewer
      data-story-id={story.id}
      // 경기 페이지 상단 스코어 헤더가 z-[100]이라 그 위로 — 풀스크린 뷰어는 모든 UI를 덮어야 함
      // ⚠️ 댓글 시트가 뜨면 인스타 스토리처럼 영상을 뒤에 그대로 보여준다(하린아빠 7/28 리포트 —
      // 이전엔 commentsOpen 되자마자 뷰어를 통째 hidden 처리해 영상이 사라져 이상했다).
      // 단, focus 직후부터 visualViewport 인셋이 0으로 복귀할 때까지를 실제 keyboard-open 수명으로
      // 보고 뷰어를 hidden 한다. onBlur가 먼저 와도 kbInset이 남은 닫힘 애니메이션 동안 fixed 비디오
      // 레이어가 재등장하지 않아 입력창 가림·배경 밀림/지터 경로를 다시 열지 않는다.
      // 댓글 오버레이는 별도 body 포털이라 뷰어가 보여도 그 위(z-130)로 정상 렌더된다.
      className={`fixed inset-0 z-[120] bg-black flex flex-col select-none overflow-hidden overscroll-none${
        commentsOpen && keyboardOpen ? " hidden" : ""
      }`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* 진행바 — iOS 네이티브 상태바(시계/배터리)는 z-index로 못 덮으므로 safe-area 아래로 (삼순 #795 blocker).
          원격 로드 WebView(server.url=keubo.fan)에서 env(safe-area-inset-top)이 0으로 잡히는 기기가 있어
          상태바와 겹침(하린아빠 iOS 리포트) → iOS 네이티브 런타임에서만 최소 44px 보장(safeAreaInsetTop).
          Android·웹/PWA는 env() 순수값 유지(삼순 #843 NO-GO — 전 플랫폼 44px 강제 회귀 방지). */}
      <div
        className="absolute top-0 left-0 right-0 z-20 flex gap-1 px-2 pointer-events-none"
        style={{ paddingTop: `calc(${safeAreaInsetTop} + 8px)` }}
      >
        {stories.map((s, i) => (
          <div key={s.id} className="flex-1 h-0.5 rounded-full bg-white/30 overflow-hidden">
            {i === index && story.mediaType === "image" ? (
              // 이미지 활성 바: WAAPI 가 transform(scaleX 0→1)을 구동 — React 리렌더 무발생
              <div
                ref={progressBarRef}
                data-story-progress="waapi"
                className="h-full w-full bg-white origin-left"
                style={{ transform: "scaleX(0)" }}
              />
            ) : (
              <div
                className="h-full bg-white"
                style={{ width: `${i < index ? 100 : i === index ? progress * 100 : 0}%` }}
              />
            )}
          </div>
        ))}
      </div>

      {/* 헤더 — 작성자/닫기도 상태바 아래로. 진행바(+8px)와 겹치지 않게 +28px 로 간격 확보(하린아빠 리포트). */}
      <div
        className="absolute left-0 right-0 z-20 flex items-center gap-2 px-3"
        style={{ top: `calc(${safeAreaInsetTop} + 28px)` }}
      >
        {/* story.id key로 remount — 이전 스토리에서 onError로 숨긴 img/flex 폴백이 다음 스토리에 남지 않게 (삼순 #805) */}
        <div key={`avatar-${story.id}`} className="w-8 h-8 rounded-full bg-white/20 overflow-hidden shrink-0">
          {(() => {
            // 아바타 `preset:`/`custom:` 해석(하린아빠 7/29 프로필 안뜸 — 날것 custom:URL 을
            // src 로 넣어 로드 실패). null 이면 이니셜 폴백.
            const resolved = getAvatarPath(story.author.avatarUrl);
            return resolved ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resolved}
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
            ) : null;
          })()}
          <div
            data-avatar-fallback
            className={`w-full h-full items-center justify-center text-white text-xs ${getAvatarPath(story.author.avatarUrl) ? "hidden" : "flex"}`}
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
          <p className="text-white/60 text-[11px] flex items-center gap-1.5">
            <span>{timeAgo(story.createdAt)}</span>
            {/* 조회수는 일단 관리자만 — 서버 필드 분기 + AdminOnly 이중 게이트. */}
            {("clickCount" in story || "impressionCount" in story) && (
              <AdminOnly>
                <span
                  className="inline-flex items-center gap-1"
                  title="관리자 전용 조회수"
                  data-venue-story-view-count
                >
                  <Eye size={12} />
                  <span>
                    조회수 {postViewTotal(story.clickCount, story.impressionCount).toLocaleString()}
                  </span>
                </span>
              </AdminOnly>
            )}
          </p>
        </div>
        {story.mediaType === "video" && (
          <button
            {...chromePressHandlers("mute", () => setMuted((m) => !m))}
            className="w-11 h-11 flex items-center justify-center text-white/90 shrink-0 touch-manipulation"
            aria-label="음소거"
          >
            {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          </button>
        )}
        <button
          {...chromePressHandlers("more", () => {
            setMenuOpen(true);
            setPaused(true);
          })}
          className="w-11 h-11 flex items-center justify-center text-white/90 shrink-0 touch-manipulation"
          aria-label="더보기"
        >
          <MoreVertical size={20} />
        </button>
        <button
          {...chromePressHandlers("close", onClose)}
          className="w-11 h-11 flex items-center justify-center text-white/90 shrink-0 touch-manipulation"
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
            data-story-media="video"
            src={story.mediaUrl}
            {...(story.thumbUrl ? { poster: story.thumbUrl } : {})}
            preload="auto"
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
            pointerdown(blur 이전) 시점의 잠금을 캡처해 click 에서 이동을 스킵한다.
            ⚠️ 하단 댓글바 위에서 끊는다(bottom 76px+safe): 예전엔 inset-y-0(전체 높이)라
            좌/우 넘김 존이 하단 '댓글 달기' pill(44px) 주변까지 덮어, 조금만 빗나가도 탭이
            스토리 넘김으로 먹혀 모달이 잘 안 떴다(하린아빠 7/29 안드 리포트 — pill 8px 위만 눌러도
            넘김 발동 재현). 캡션(72px)+pill 영역을 넘김 존에서 제외해 하단 탭이 모달 오픈으로 간다. */}
        <button
          className="absolute top-0 left-0 w-1/3 touch-manipulation"
          style={{ bottom: safeBottomCalc(STORY_NAV_BOTTOM_OFFSET) }}
          aria-label="이전"
          onClick={(e) => handleStoryNavClick("prev", e.detail)}
          onPointerDown={(e) => {
            e.preventDefault();
            markPressStart(storyNavPressRef.current);
            setPaused(true);
          }}
          onPointerUp={(e) => handleStoryNavPointerUp("prev", e)}
          onPointerCancel={() => {
            cancelPress(storyNavPressRef.current);
            setPaused(false);
          }}
          onPointerLeave={() => {
            cancelPress(storyNavPressRef.current);
            setPaused(false);
          }}
        />
        <button
          className="absolute top-0 right-0 w-2/3 touch-manipulation"
          style={{ bottom: safeBottomCalc(STORY_NAV_BOTTOM_OFFSET) }}
          aria-label="다음"
          onClick={(e) => handleStoryNavClick("next", e.detail)}
          onPointerDown={(e) => {
            e.preventDefault();
            markPressStart(storyNavPressRef.current);
            setPaused(true);
          }}
          onPointerUp={(e) => handleStoryNavPointerUp("next", e)}
          onPointerCancel={() => {
            cancelPress(storyNavPressRef.current);
            setPaused(false);
          }}
          onPointerLeave={() => {
            cancelPress(storyNavPressRef.current);
            setPaused(false);
          }}
        />
      </div>

      {/* 캡션 — 하단 상시 입력바 위로 */}
      {story.caption && (
        <div
          className="absolute left-0 right-0 pl-4 pr-20 z-20 pointer-events-none"
          style={{ bottom: safeBottomCalc(STORY_CAPTION_BOTTOM_OFFSET) }}
        >
          <p className="text-white text-sm bg-black/40 rounded-xl px-3 py-2 inline-block max-w-full break-words">
            {story.caption}
          </p>
        </div>
      )}

      {/* 하단 댓글 버튼 — 인라인 입력바 대신 탭하면 댓글 모달(바텀시트) 오픈(하린아빠 7/25 지시 —
          인앱브라우저 기사 댓글 모달과 동일 UX). iOS 키보드 회피는 모달 셔(CommentSheet 패턴)에서 처리. */}
      {/* 터치 타깃을 h-12로 키우고 안드로이드 제스처바 위로 띄운다(+20px). 넘기기 탭 존은 이제
          이 pill 위에서 끔기므로 pill 주변 탭이 스토리 넘김으로 샘나지 않는다(하린아빠 7/29 안드). */}
      <button
        data-open-comments
        {...chromePressHandlers("comments", () => {
          setCommentsClosing(false);
          setCommentError(null);
          setCommentsOpen(true);
        })}
        className="absolute left-3 right-3 z-20 h-12 flex items-center gap-2 px-4 rounded-full bg-black/40 border border-white/25 text-white/80"
        style={{ bottom: safeBottomCalc(STORY_PILL_BOTTOM_OFFSET) }}
        aria-label="댓글 목록"
      >
        <MessageCircle size={18} />
        <span className="text-sm">
          {commentTotal && commentTotal > 0 ? `댓글 ${commentTotal}개` : "댓글 달기..."}
        </span>
      </button>

      {/* 댓글 모달(바텀시트) — 커뮤니티 댓글 모달(CommentSheet)과 동일한 디자인·키보드 회피 구조(하린아빠 7/25 지시).
          ⚠️ position:fixed 로 뷰포트에 직접 앵커(과거 absolute-in-fixed 는 iOS 에서 키보드 회피가 어긋나 입력창이
          키보드 뒤로 가렸다 — 하린아빠 iOS 리포트). bottom=kbInset 로 컴포저를 키보드 위로 올리고, 포커스 시
          height=vvHeight 로 확장해 목록+컴포저가 키보드 위에 함께 보인다. 배경/영상은 뷰어 root scroll lock 으로 잠금.
          ⚠️⚠️ 이 시트는 뷰어 motion.div(framer-motion opacity/exit + AnimatePresence) 서브트리 밖, document.body 로
          직접 포털한다. 뷰어 컨테이너가 만드는 containing block/트랜스폼 컨텍스트 안에 position:fixed 시트가 갇히면
          iOS 실기기에서 키보드가 뜰 때 bottom=kbInset 이 시각 뷰포트가 아니라 갇힌 조상 기준으로 잡혀 컴포저/목록이
          키보드 뒤로 사라진다(#863 BrowserStack Safari 는 통과했으나 실기기 재현 — 하린아빠 iOS 리포트 7/26).
          정상 동작하는 커뮤니티 CommentSheet 와 동일하게 body 포털로 escape 한다.
          body sibling 이 된 뒤에는 뷰어 root(z-120)보다 반드시 위여야 하므로 overlay tier를 z-130으로 둔다.
          댓글이 열린 동안 뷰어 내부 메뉴/토스트(z-30/40)는 의도적으로 댓글 overlay 아래에 잠긴다. */}
      {commentsOpen &&
        createPortal(
          <motion.div
          data-venue-story-comment-overlay
          data-keyboard-open={keyboardOpen ? "true" : "false"}
          className="fixed inset-0 z-[130] bg-black/60"
          // 백드롭에서 뒷 콘텐츠로 스크롤/오버스크롤 전파 차단(CommentSheet 동일) — 키보드 열린 상태에서
          // 백드롭 드래그가 배경(경기방)을 밀어내리는 것을 막는다(하린아빠 iOS 리포트: 스크롤 시 배경 내려감).
          style={{ touchAction: "none", overscrollBehavior: "none" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: commentsClosing ? 0 : 1 }}
          transition={{ duration: 0.2 }}
          onClick={requestCommentsClose}
          onTouchMove={(e) => {
            if (e.cancelable) e.preventDefault();
          }}
        >
          <motion.div
            data-venue-story-comment-sheet
            className="fixed inset-x-0 z-[1] flex flex-col bg-bg-secondary rounded-t-2xl overflow-hidden"
            style={{
              bottom: kbInset,
              height:
                keyboardOpen && vvHeight != null
                  ? `${vvHeight}px`
                  : vvHeight != null
                    ? `min(60dvh, ${vvHeight}px)`
                    : "60dvh",
            }}
            initial={{ y: "100%" }}
            animate={{ y: commentsClosing ? "100%" : 0 }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
            onAnimationComplete={() => {
              if (commentsClosing) {
                setCommentsOpen(false);
                setCommentsClosing(false);
              }
            }}
            onTouchStart={handleCommentSheetTouchStart}
            onTouchMove={handleCommentSheetTouchMove}
            onTouchEnd={handleCommentSheetTouchEnd}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drag handle (CommentSheet 동일) */}
            <div className="flex justify-center pt-3 pb-2 shrink-0">
              <div className="w-10 h-1 rounded-full bg-text-tertiary/40" />
            </div>

            {/* Header (CommentSheet 동일 — 가운데 제목 + 우상단 X) */}
            <div className="relative px-4 pb-3 border-b border-border shrink-0">
              <h3 className="text-base font-semibold text-text-primary text-center">댓글</h3>
              <button
                onClick={requestCommentsClose}
                className="absolute right-4 top-0 p-1 text-text-tertiary hover:text-text-primary transition-colors"
                aria-label="댓글 닫기"
              >
                <X size={20} />
              </button>
            </div>

            {/* Comment list (CommentSheet 동일 — px-4 py-3 space-y-4, 아바타 8x8) */}
            <div
              ref={sheetListRef}
              data-comment-scroll="true"
              className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3 space-y-4"
            >
              {comments == null ? (
                <div className="space-y-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex gap-2.5 animate-pulse">
                      <div className="w-8 h-8 rounded-full bg-bg-tertiary flex-shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3 bg-bg-tertiary rounded w-20" />
                        <div className="h-3.5 bg-bg-tertiary rounded w-3/4" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : comments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
                  <p className="text-base">첫 댓글을 남겨보세요 💬</p>
                </div>
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="flex gap-2.5">
                    <CommentAvatar
                      avatarUrl={c.author.avatarUrl}
                      nickname={c.author.nickname}
                      className="w-8 h-8 rounded-full bg-bg-tertiary overflow-hidden flex-shrink-0"
                      initialClassName="text-text-secondary text-xs"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-text-secondary text-xs truncate">
                          {c.author.nickname ?? "익명"}
                        </span>
                        {(() => {
                          const team =
                            c.author.teamId != null ? getTeamById(c.author.teamId) : undefined;
                          if (!team) return null;
                          return (
                            <span
                              className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold text-white leading-none"
                              style={{ backgroundColor: getTeamBgColor(team, "dark") }}
                            >
                              {team.shortName}
                            </span>
                          );
                        })()}
                        <span className="shrink-0 text-text-tertiary text-xs">
                          · {timeAgo(c.createdAt)}
                        </span>
                      </div>
                      <p className="text-text-primary text-sm break-words mt-0.5">{c.content}</p>
                    </div>
                    {currentUserId != null && c.userId === currentUserId && (
                      <button
                        onClick={() => handleCommentDelete(c.id)}
                        disabled={commentBusy}
                        className="w-7 h-7 flex items-center justify-center text-text-tertiary hover:text-text-primary shrink-0"
                        aria-label="댓글 삭제"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Input area (CommentSheet 동일 — border-t border-border, rounded-full bg-bg-tertiary 입력창 + 레드 전송버튼).
                data-composer 는 iOS 실기기 키보드 QA(browserstack-ios-story-comments-keyboard.mjs) 마커. */}
            <div
              data-composer="venue-story"
              className="flex-none border-t border-border px-4 py-3"
              style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
            >
              {commentError && (
                <p
                  data-comment-error
                  role="alert"
                  aria-live="assertive"
                  className="mb-2 text-sm text-red-400"
                >
                  {commentError}
                </p>
              )}
              <div className="flex items-center gap-2">
                <input
                  value={commentInput}
                  onChange={(e) => {
                    setCommentInput(e.target.value);
                    if (commentError) setCommentError(null);
                  }}
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) handleCommentSubmit();
                  }}
                  maxLength={VENUE_STORY_COMMENT_MAX_LENGTH}
                  placeholder="댓글을 입력하세요"
                  className="flex-1 min-w-0 bg-bg-tertiary rounded-full px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary outline-none border"
                  style={{ borderColor: "rgba(255,255,255,0.15)" }}
                />
                <button
                  // 안드로이드 전송 씨음 핵심 수정(하린아빠 7/29 갤럭시 리포트 — 전송 눌러도 토스트·저장 안 됨):
                  // onClick 은 전송 탭 순간 입력창 blur→안드 키보드 내려감→시트 높이 재계산으로 버튼이
                  // 손가락 밑에서 이동해 click 이 씨힌다. pointerdown 은 preventDefault(입력창 포커스 유지
                  // →키보드/시트 불변)만 하고, 제출 확정은 "버튼 위에서 끝난 primary pointerup"(불변 버튼)에서만.
                  // 삼순 #948 blocker1: pointerdown 즉시 제출은 pointercancel(스크롤)·drag-out 도 전송하므로 금지.
                  // onClick 은 데스크톱 키보드/마우스 폴백(ref lock 으로 trailing click 중복 차단).
                  onPointerDown={(e) => {
                    e.preventDefault();
                    markPressStart(commentPressRef.current);
                  }}
                  onPointerUp={(e) => {
                    const b = e.currentTarget.getBoundingClientRect();
                    if (
                      shouldSubmitOnPointerUp(commentPressRef.current, {
                        isPrimary: e.isPrimary,
                        button: e.button,
                        clientX: e.clientX,
                        clientY: e.clientY,
                        bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
                      })
                    ) {
                      handleCommentSubmit();
                    }
                  }}
                  onPointerCancel={() => cancelPress(commentPressRef.current)}
                  onPointerLeave={() => cancelPress(commentPressRef.current)}
                  onClick={handleCommentSubmit}
                  disabled={commentBusy || commentInput.trim().length === 0}
                  className="flex items-center justify-center w-9 h-9 rounded-full text-white disabled:opacity-50 transition-opacity shrink-0"
                  style={{ backgroundColor: "#FF453A" }}
                  aria-label="댓글 등록"
                >
                  {commentBusy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </motion.div>
          </motion.div>,
          document.body,
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
