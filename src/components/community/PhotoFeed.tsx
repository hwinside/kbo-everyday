"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Maximize, MessageCircle, Minimize, MoreHorizontal, Share2, Volume2, VolumeX } from "lucide-react";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { parseAttribution } from "@/lib/gif-collector/attribution";
import TeamBadge from "@/components/ui/TeamBadge";
import CommunityAuthorHeader from "@/components/community/CommunityAuthorHeader";
import type { Post } from "@/lib/supabase/usePosts";
import { deletePost } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getPostSourceLabel, type CommunitySourceLabel } from "@/lib/utils/community-board";
import ShareSheet, { type ShareSheetPost } from "@/components/community/ShareSheet";
import PostViewBadge from "@/components/community/PostViewBadge";
import { usePostImpression } from "@/lib/community/usePostImpression";
import CommentSheet from "./CommentSheet";
import { isShortText, BrandedTextCard } from "./FeedTextCards";
import PollCardSlot from "./PollCardSlot";
import { fetchPollSummaries, type PollSummary } from "@/lib/community/poll-client";

/** 카드 최상위에 임프레션 ref를 걸어 세로 50%+ 노출 시 조회수를 집계하는 래퍼. */
function PostImpressionWrapper({
  postId,
  className,
  children,
}: {
  postId: number;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = usePostImpression<HTMLDivElement>(postId);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

interface PhotoFeedProps {
  posts: Post[];
  loading: boolean;
  onLike: (postId: number) => void;
  boardType?: "team" | "player";
  /** 선수 게시판: post별 playerLabel 맵 (postId → {teamId, playerName}) */
  playerLabels?: Record<number, { teamId: number; playerName: string }>;
  sourceLabels?: Record<number, CommunitySourceLabel>;
  /**
   * controlled 좋아요 모드: 부모가 좋아요 상태를 소유(배치 프리페치 + optimistic + 롤백)할 때 주입.
   * 주입되면 PhotoFeed 내부 Set 대신 이 Set으로 하트를 그리고, like_count는 부모가 이미 보정한 값을 그대로 표시.
   * 미주입 시 기존 동작(내부 Set, like_count + isLiked) 유지.
   */
  likedIds?: Set<number>;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  return new Date(dateStr).toLocaleDateString("ko-KR");
}

/** 제목 필드 제거(spec §4·§11) → 기존 글의 title+content를 하나의 본문으로 합쳐 렌더.
 *  단, 움짤콜렉터 등 title===content(또는 본문이 제목으로 시작)인 글은 중복 노출 방지(③). */
function mergedBody(post: Post): string {
  const t = (post.title ?? "").trim();
  const c = (post.content ?? "").trim();
  if (!t) return c;
  if (!c) return t;
  if (c === t || c.startsWith(t)) return c;
  return `${t}\n${c}`;
}

export interface MediaSlide {
  url: string;
  isVideo: boolean;
}

// 화면에 동영상이 2개 이상 떠 있을 때 화면 중앙에 가장 가까운 1개만 재생.
// iOS Safari가 동시 muted-autoplay를 막아 "재생 안 됨"으로 보이던 문제도 함께 해소.
const videoRegistry = new Set<HTMLVideoElement>();
let videoObserver: IntersectionObserver | null = null;
let videoRecomputeScheduled = false;
let videoScrollBound = false;
const VIDEO_MIN_VISIBLE = 0.5; // 절반 이상 보일 때만 재생 대상

// 영상 음소거 전역 상태 — 기본 음소거(인스타 동일). 우하단 토글 버튼으로 한 번 소리를 켜면
// 이후 포커스되는 모든 영상에 그대로 유지된다. 모듈 스코프 + 구독자 set으로 모든 FeedVideo가 동기화.
let globalVideoMuted = true;
const muteSubscribers = new Set<() => void>();
function setGlobalVideoMuted(next: boolean) {
  globalVideoMuted = next;
  muteSubscribers.forEach((fn) => fn());
}
function useGlobalVideoMuted(): [boolean, (next: boolean) => void] {
  const [muted, setLocal] = useState(globalVideoMuted);
  useEffect(() => {
    const sync = () => setLocal(globalVideoMuted);
    muteSubscribers.add(sync);
    sync();
    return () => {
      muteSubscribers.delete(sync);
    };
  }, []);
  return [muted, setGlobalVideoMuted];
}

// 재생 대상 = 뷰포트 중앙에 세로 중심이 가장 가까운 영상 (가로·세로 모두 절반 이상 보이는 것 중).
// intersectionRatio(엘리먼트 자기 크기 대비 비율)로 고르면, 작거나 아래쪽 영상이 "꽉 차 보여서"
// 위쪽 큰 영상보다 비율이 높게 잡혀 엉뚱한 영상이 재생되던 문제가 있었다. 매 호출마다 live
// getBoundingClientRect를 읽어 위치 기준으로 고르면 스크롤 위치와 화면상 보이는 것이 일치한다.
function recomputeVideoFocus() {
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const focusLine = vh / 2;
  let best: HTMLVideoElement | null = null;
  let bestDist = Infinity;
  videoRegistry.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return;
    const visibleY = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    if (visibleY / rect.height < VIDEO_MIN_VISIBLE) return; // 세로 절반 미만은 후보 제외
    // 캐러셀에서 가로로 나란히 놓인 슬라이드는 rect.top/bottom(세로)이 같아, 가로로 벗어난
    // offscreen 슬라이드도 세로 거리로 best가 될 수 있다. 가로 가시성도 함께 봐서 제외한다.
    const visibleX = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    if (visibleX / rect.width < VIDEO_MIN_VISIBLE) return; // 가로 절반 미만은 후보 제외
    const dist = Math.abs((rect.top + rect.bottom) / 2 - focusLine);
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
    }
  });
  videoRegistry.forEach((el) => {
    if (el === best) {
      el.play().catch(() => {});
    } else if (!el.paused) {
      el.pause();
    }
  });
}

function scheduleVideoRecompute() {
  if (videoRecomputeScheduled) return;
  videoRecomputeScheduled = true;
  requestAnimationFrame(() => {
    videoRecomputeScheduled = false;
    recomputeVideoFocus();
  });
}

function ensureVideoObserver(): IntersectionObserver {
  if (videoObserver) return videoObserver;
  videoObserver = new IntersectionObserver(() => scheduleVideoRecompute(), {
    threshold: [0, 0.25, 0.5, 0.75, 1],
  });
  // IntersectionObserver는 threshold를 넘을 때만 발화하므로, 연속 스크롤 중 화면상 위치가
  // 바뀌어도 재계산이 안 될 수 있다. passive scroll/resize로 위치 기준 포커스를 따라가게 한다.
  if (!videoScrollBound && typeof window !== "undefined") {
    videoScrollBound = true;
    // capture: true → 중첩 스크롤 컨테이너(scroll 이벤트는 버블 안 함)에서도 잡는다.
    window.addEventListener("scroll", scheduleVideoRecompute, { passive: true, capture: true });
    window.addEventListener("resize", scheduleVideoRecompute, { passive: true });
  }
  return videoObserver;
}

// 영상 lazy-load: 화면(+아래 ~0.8화면)에 들어온 영상만 src/preload를 활성화한다. 모든 영상을 한꺼번에
// preload="metadata"로 깔면 피드 한참 아래 영상이 위쪽보다 먼저 로드되고, 포스터+플레이어 2개 레이어라
// 디코더/네트워크 부담이 커진다. rootMargin으로 "뷰포트 + 다음 1~2개"만 로드 시작하게 한다.
let videoLoadObserver: IntersectionObserver | null = null;
const videoLoadCallbacks = new WeakMap<Element, () => void>();
function ensureVideoLoadObserver(): IntersectionObserver {
  if (videoLoadObserver) return videoLoadObserver;
  const ahead = typeof window !== "undefined" ? Math.round((window.innerHeight || 800) * 0.8) : 640;
  videoLoadObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const cb = videoLoadCallbacks.get(e.target);
        if (cb) {
          cb();
          videoLoadObserver?.unobserve(e.target); // 한 번 로드 허용되면 sticky (스크롤 업 시 재언로드 방지)
          videoLoadCallbacks.delete(e.target);
        }
      });
    },
    { rootMargin: `300px 0px ${ahead}px 0px`, threshold: 0 },
  );
  return videoLoadObserver;
}

// iOS Safari는 preload="metadata"만으론 첫 프레임을 그리지 않아, 재생 중이 아닌(일시정지) 영상이
// poster 없이 검은 배경(bg-black)만 보인다. 미디어 프래그먼트 #t= 로 시작 시점을 지정하면 재생 없이도
// 해당 프레임을 디코드해 poster처럼 페인트한다. → 캐러셀에서 가운데 1개만 재생되고 나머지 슬라이드는
// 검은 화면 대신 첫 프레임을 보여준다. (움짤콜렉터 다중 영상 글에서 2·3번째가 검게 나오던 문제)
function videoPosterSrc(url: string): string {
  return url.includes("#") ? url : `${url}#t=0.001`;
}

// 1x1 투명 poster. poster 미지정 시 일부 브라우저(안드로이드 WebView/삼성인터넷)가 로딩/일시정지 중
// 조악한 기본 재생버튼 글리프를 그린다. 투명 poster를 주면 그 글리프 대신 우리 스피너만 보인다.
const TRANSPARENT_POSTER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// iPhone Safari/WKWebView는 임의 엘리먼트 requestFullscreen 미지원(document.fullscreenEnabled=false).
// 대신 <video>.webkitEnterFullscreen()으로 네이티브 플레이어(회전·컨트롤·닫기 내장)를 띄운다.
type WebkitFullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
};

function unlockOrientation() {
  try {
    (screen.orientation as LockableOrientation | undefined)?.unlock?.();
  } catch {
    // 데스크톱 등 unlock 미지원 환경 무시
  }
}

function FeedVideo({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useGlobalVideoMuted();
  const [loading, setLoading] = useState(false);
  // 실제 프레임이 재생되는 동안에만 플레이어를 노출(opacity)한다. 버퍼링/일시정지 중에는 플레이어가
  // 투명이 되어 뒤에 깔린 포스터(첫 프레임 썸네일)가 보인다. → 재생 시작 시 검은 화면으로 빠지던 문제 해소.
  const [playing, setPlaying] = useState(false);
  // lazy-load: 뷰포트(+아래 ~0.8화면)에 가까워질 때까지 src/preload를 비워 둔다. 위→아래 순서 로딩 +
  // 화면 밖 아래쪽 영상 선로딩 1~2개 제한 (포스터+플레이어 2레이어 디코더/네트워크 부담 완화).
  const [shouldLoad, setShouldLoad] = useState(false);
  // 컨테이너 Fullscreen API 경로(안드/웹)에서만 true. iOS 네이티브 플레이어 경로는 자체 UI라 관여 안 함.
  const [fullscreen, setFullscreen] = useState(false);

  const enterFullscreen = useCallback(async () => {
    const container = containerRef.current;
    const el = ref.current as WebkitFullscreenVideo | null;
    if (!el || document.fullscreenElement) return;
    if (container && document.fullscreenEnabled) {
      try {
        await container.requestFullscreen();
      } catch {
        return; // (비제스처 호출 등) 거부되면 조용히 무시
      }
      // 가로 영상만 landscape 잠금 — 세로(9:16) 영상에 강제하면 정반대로 망가진다(#510 교훈).
      if (el.videoWidth > el.videoHeight) {
        try {
          await (screen.orientation as LockableOrientation | undefined)?.lock?.("landscape");
        } catch {
          // 데스크톱/미지원 환경은 잠금 없이 전체화면만
        }
      }
    } else if (el.webkitEnterFullscreen) {
      try {
        el.webkitEnterFullscreen();
      } catch {
        // iOS는 사용자 제스처 밖 호출을 거부할 수 있음 (자동 진입 한계)
      }
    }
  }, []);

  const exitFullscreen = useCallback(() => {
    unlockOrientation();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  // 전체화면 상태 동기화: ESC/뒤로가기 등 브라우저 주도 이탈도 여기서 잡아 orientation 잠금을 푼다.
  useEffect(() => {
    const onFsChange = () => {
      const container = containerRef.current;
      const active = !!document.fullscreenElement && !!container && (document.fullscreenElement === container || container.contains(document.fullscreenElement));
      setFullscreen(active);
      if (!active) unlockOrientation();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // 폰을 눕히면(landscape 회전) 재생 중인 영상만 자동 전체화면 진입. 재생 대상은 항상 1개뿐이라
  // (videoRegistry 포커스) 여러 영상이 동시에 진입을 다투지 않는다. iOS는 회전 이벤트가 user gesture가
  // 아니라 webkitEnterFullscreen이 거부될 수 있음 — 그 경우 오버레이 버튼(제스처)으로 진입.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(orientation: landscape)");
    const onChange = () => {
      const el = ref.current;
      if (!mql.matches || !el || el.paused || document.fullscreenElement) return;
      void enterFullscreen();
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [enterFullscreen]);

  useEffect(() => {
    if (shouldLoad) return;
    const node = containerRef.current;
    if (!node) return;
    const obs = ensureVideoLoadObserver();
    videoLoadCallbacks.set(node, () => setShouldLoad(true));
    obs.observe(node);
    return () => {
      obs.unobserve(node);
      videoLoadCallbacks.delete(node);
    };
  }, [shouldLoad]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = ensureVideoObserver();
    videoRegistry.add(el);
    observer.observe(el);
    // preload="metadata" + 정적 화면에서 첫 recompute의 play()가 데이터 준비 전이라 시작되지
    // 못하면, 스크롤/IO 추가 트리거가 없어 영상이 첫 프레임(poster)에 멈춘 채 재생되지 않던 문제.
    // (이전 IO-ratio 방식은 로딩 중 IO가 여러 번 발화해 play()를 자연히 재시도했었다.)
    // 재생 가능한 데이터를 확보(loadeddata/canplay)할 때 포커스 재계산을 돌려 play()를 다시 시도한다.
    const retryPlay = () => scheduleVideoRecompute();
    el.addEventListener("loadeddata", retryPlay);
    el.addEventListener("canplay", retryPlay);
    return () => {
      el.removeEventListener("loadeddata", retryPlay);
      el.removeEventListener("canplay", retryPlay);
      observer.unobserve(el);
      videoRegistry.delete(el);
      recomputeVideoFocus();
    };
  }, []);

  // 로딩 인디케이터: "지금 재생 중인(포커스된) 영상이 데이터를 기다리며 버퍼링할 때"만 스피너.
  // #t=0.001 poster 프레임을 디코드하는 seek도 waiting을 발생시키므로, 재생 중이 아닌(paused)
  // 영상까지 스피너가 켜져 모든 영상이 검은 화면 위에서 스피너만 돌던 문제가 있었다(첫 배포 회귀).
  // → waiting 시 !el.paused 가드로 재생 대상 1개에만 표시, pause(포커스 잃음)/ended/error 시 숨김.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 재생 중 재버퍼링(waiting/stalled)이 오면 플레이어를 다시 투명으로 돌려(setPlaying(false)) 뒤의
    // 포스터(썸네일)가 보이게 한다. 안 그러면 opacity가 1로 남아 검은 버퍼 프레임이 포스터를 덮는다.
    const onWaiting = () => { if (!el.paused) { setLoading(true); setPlaying(false); } };
    const onPlaying = () => { setLoading(false); setPlaying(true); };
    const onCanPlay = () => setLoading(false);
    const onStopped = () => { setLoading(false); setPlaying(false); };
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("stalled", onWaiting);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("pause", onStopped);
    el.addEventListener("ended", onStopped);
    el.addEventListener("error", onStopped);
    return () => {
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("stalled", onWaiting);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("pause", onStopped);
      el.removeEventListener("ended", onStopped);
      el.removeEventListener("error", onStopped);
    };
  }, []);

  // 전역 음소거 상태를 element에 반영. React의 muted 속성은 property 반영이 불안정해 직접 세팅.
  // 소리를 켠 직후 포커스된 영상은 사용자 제스처 컨텍스트라 iOS에서도 사운드 재생이 허용된다.
  useEffect(() => {
    const el = ref.current;
    if (el) el.muted = muted;
  }, [muted]);

  return (
    // 로드 전에는 16:9(aspect-video) 박스로 세로 공간을 예약한다. (이전 56vh 고정은 가로 영상보다
    // 훨씬 커서 캐러셀에서 영상 위아래 회색 레터박스를 유발했다.) 로드 후엔 영상 natural 높이로.
    <div
      ref={containerRef}
      className={`relative w-full bg-black${shouldLoad ? "" : " aspect-video"}${fullscreen ? " flex items-center justify-center" : ""}`}
    >
      {/* 포스터 레이어: 첫 프레임만 보여주는 일시정지 영상(재생하지 않음). 플레이어가 버퍼링/일시정지로
          투명일 때 뒤에서 썸네일(첫 프레임)을 항상 노출한다. 일시정지 #t=0.001 프레임은 안정적으로
          페인트되므로(재생 중 검은 화면으로 빠지지 않음) 로딩 내내 썸네일이 보인다.
          src/preload는 lazy-load(shouldLoad) 전까지 비워 둔다. */}
      <video
        src={shouldLoad ? videoPosterSrc(url) : undefined}
        poster={TRANSPARENT_POSTER}
        muted
        playsInline
        preload={shouldLoad ? "metadata" : "none"}
        tabIndex={-1}
        aria-hidden
        className="absolute inset-0 h-full w-full object-contain pointer-events-none select-none"
        style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
      />
      {/* 플레이어: 실제 프레임이 재생되는 동안(playing)만 노출. 버퍼링/일시정지 땐 투명 → 포스터 노출 */}
      <video
        ref={ref}
        src={shouldLoad ? videoPosterSrc(url) : undefined}
        poster={TRANSPARENT_POSTER}
        muted={muted}
        loop
        playsInline
        preload={shouldLoad ? "metadata" : "none"}
        className={`relative w-full object-contain pointer-events-none select-none${fullscreen ? " h-full" : ""}`}
        style={{ maxHeight: fullscreen ? "100vh" : "80vh", opacity: playing ? 1 : 0, transition: "opacity 120ms ease", WebkitTouchCallout: "none" } as React.CSSProperties}
      />
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-8 w-8 animate-spin text-white/90 drop-shadow" />
        </div>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setMuted(!muted); }}
        className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm pointer-events-auto"
        aria-label={muted ? "소리 켜기" : "소리 끄기"}
      >
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (fullscreen) exitFullscreen();
          else void enterFullscreen();
        }}
        className="absolute bottom-2 right-12 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm pointer-events-auto"
        aria-label={fullscreen ? "전체화면 종료" : "전체화면"}
      >
        {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
      </button>
    </div>
  );
}

function MediaElement({ url, isVideo, sizes, active = true }: { url: string; isVideo: boolean; sizes?: string; active?: boolean }) {
  const isGif = !isVideo && url.toLowerCase().endsWith(".gif");

  if (isVideo) {
    // 캐러셀 비활성 슬라이드는 <video>를 아예 언마운트해 디코더를 반납한다. src만 떼는 방식은
    // React가 controlled src를 다시 동기화해 currentSrc/디코더가 안 풀려서(스와이프 시 2→4→6 누적)
    // iOS WKWebView 동시 영상 디코딩 한도를 초과 → 보이는 영상이 무한 버퍼링으로 멈춘다.
    // 활성 슬라이드만 마운트 = 동시 <video> 2개(poster+player)로 제한. 비활성은 placeholder(로드 전 예약과 동일 56vh).
    if (!active) {
      return <div className="w-full bg-black aspect-video" aria-hidden />;
    }
    return <FeedVideo url={url} />;
  }

  if (isGif) {
    return (
      <Image
        src={url}
        alt="gif"
        width={800}
        height={600}
        unoptimized
        className="w-full object-contain pointer-events-none select-none bg-black"
        draggable={false}
        style={{ maxHeight: "80vh", WebkitTouchCallout: "none" } as React.CSSProperties}
        sizes={sizes ?? "(max-width: 768px) 100vw, 600px"}
      />
    );
  }

  return (
    <Image
      src={url}
      alt="photo"
      width={800}
      height={1000}
      className="w-full object-contain pointer-events-none select-none bg-black"
      draggable={false}
      style={{ maxHeight: "80vh", WebkitTouchCallout: "none" } as React.CSSProperties}
      sizes={sizes ?? "(max-width: 768px) 100vw, 600px"}
    />
  );
}

function ZoomableSlide({
  slide,
  elevationGrace,
  onZoomChange,
  onScale,
  active = true,
}: {
  slide: MediaSlide;
  // zoom 종료 직후 dim overlay exit fade(0.24s) 동안 wrapper z-elevation을 유지하기 위한 grace 신호.
  // 부모(PhotoCarousel)가 dim exit와 같은 길이로 켰다 끄는 별도 state(zoomCooldown 80ms와 분리).
  elevationGrace: boolean;
  onZoomChange: (zoomed: boolean) => void;
  onScale: (scale: number) => void;
  // 캐러셀 현재 슬라이드 여부 — 영상은 비활성 시 언마운트(디코더 반납). 기본 true.
  active?: boolean;
}) {
  const wrapperRef = useRef<ReactZoomPanPinchRef>(null);
  const [isZooming, setIsZooming] = useState(false);
  // onPinchStop과 onPanningStop이 동일 release에서 둘 다 fire되어 handleReset이 중복 실행되는 것 차단.
  const resetPending = useRef(false);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 부드러운 reset: lib resetTransform animation으로 scale을 천천히 1로 → animation 끝에 state 정리.
  // animation 중에는 onTransform의 setIsZooming 갱신을 막아 dim overlay가 끊기지 않게 유지.
  const RESET_ANIMATION_MS = 240;
  const handleReset = useCallback(() => {
    if (resetPending.current) return;
    resetPending.current = true;
    wrapperRef.current?.resetTransform(RESET_ANIMATION_MS, "easeOut");
    if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    resetTimeoutRef.current = setTimeout(() => {
      setIsZooming(false);
      onZoomChange(false);
      onScale(1);
      resetPending.current = false;
    }, RESET_ANIMATION_MS);
  }, [onZoomChange, onScale]);

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    };
  }, []);

  if (slide.isVideo) {
    return <MediaElement url={slide.url} isVideo={slide.isVideo} active={active} />;
  }

  // 자리 줌(인스타식): 사진을 viewport로 옮기지 않고 인라인 자리에서 그대로 확대.
  // dim overlay는 PhotoCarousel(transform 없는 부모) 레벨에 두어 viewport 기준으로 깔림.
  // elevationGrace 동안 z-50 유지 — reset 끝에서 이미지 elevation이 dim(z-40) 아래로 떨어져
  // 한 프레임 paint flicker(header/tab 재페인트)가 노출되는 회귀 방지. dim exit fade와 같은 길이.
  // touch-none은 isZooming 일 때만 — reset 후 grace 동안은 사용자 터치를 막을 이유가 없음.
  const elevated = isZooming || elevationGrace;
  return (
    <div
      className={
        elevated
          ? `relative w-full z-50${isZooming ? " touch-none" : ""}`
          : "relative w-full"
      }
      style={elevated ? { willChange: "transform", transform: "translateZ(0)" } : undefined}
    >
      <TransformWrapper
        ref={wrapperRef}
        initialScale={1}
        minScale={1}
        maxScale={4}
        doubleClick={{ disabled: true }}
        wheel={{ disabled: true }}
        // scale=1에서는 판닝 비활성 — 단일 손가락 세로 스와이프가 페이지 스크롤로 이어지도록 native scroll에 양보
        panning={{ velocityDisabled: true, disabled: !isZooming }}
        onPinchStop={handleReset}
        onPanningStop={(ref) => {
          if (ref.state.scale > 1.01) handleReset();
        }}
        onTransform={(_ref, state) => {
          onScale(state.scale);
          if (resetPending.current) return;
          const zooming = state.scale > 1.01;
          setIsZooming(zooming);
          onZoomChange(zooming);
        }}
      >
        <TransformComponent
          wrapperClass="!w-full !h-auto"
          // lib 내부 wrapper가 overflow:hidden을 박아 자리 줌 시 부풀린 사진을 잘라먹는 걸 풀어줌.
          wrapperStyle={{ overflow: "visible" }}
          contentClass="!w-full"
        >
          <MediaElement url={slide.url} isVideo={slide.isVideo} />
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
}

export function PhotoCarousel({
  slides,
  onDoubleTap,
  onZoomActiveChange,
}: {
  slides: MediaSlide[];
  onDoubleTap: () => void;
  onZoomActiveChange?: (active: boolean) => void;
}) {
  const [current, setCurrent] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const touchDeltaX = useRef(0);
  // 수직/수평 스와이프 의도 판별 — 세로 스크롤을 캐러셀이 가로채지 않도록
  const swipeAxisRef = useRef<"none" | "horizontal" | "vertical">("none");
  const [translateX, setTranslateX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const lastTapRef = useRef(0);
  // 줌이 활성화된 슬라이드는 캐러셀 swipe를 막아야 핀치/팬 제스처와 충돌하지 않음
  const [zoomedIdx, setZoomedIdx] = useState<number | null>(null);
  // setState batch 윈도우 안에서 캐러셀이 swipe 시작하지 않도록 동기 ref로 scale 추적
  const currentScaleRef = useRef(1);

  // zoomedIdx가 null로 전환된 직후 한 프레임 동안 캐러셀 transition을 잠가
  // 풀스크린 → 인라인 복귀 시 슬라이드 swoosh 0.3s 애니메이션 방지
  const [zoomCooldown, setZoomCooldown] = useState(false);
  const cooldownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // dim overlay exit fade(0.24s) 동안 이미지 z-elevation을 유지 — grace 끝에 이미지가 z-default로
  // 내려가도 dim이 이미 충분히 퇴장해 dark flash가 없도록 dim exit 길이와 맞춤.
  const [elevationGrace, setElevationGrace] = useState(false);
  const elevationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 줌 활성 여부 부모로 전파 — 부모가 자기 overflow:hidden을 풀어 fixed overlay가 viewport까지 확장되도록.
  // zoomCooldown 동안에도 active로 보고해서 lib resetTransform animation이 정착하기 전에 overflow:hidden이 다시 박혀
  // 부풀린 사진을 잠깐 잘라먹는 깜빡임을 방지.
  useEffect(() => {
    onZoomActiveChange?.(zoomedIdx !== null || zoomCooldown);
  }, [zoomedIdx, zoomCooldown, onZoomActiveChange]);

  useEffect(() => {
    return () => {
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
      if (elevationTimeoutRef.current) clearTimeout(elevationTimeoutRef.current);
    };
  }, []);

  // cooldown은 effect가 아니라 zoom-out event 시점에 직접 arm — set-state-in-effect 회피.
  const handleZoomChange = useCallback((idx: number, zoomed: boolean) => {
    if (zoomed) {
      setZoomedIdx(idx);
      return;
    }
    setZoomedIdx((prev) => (prev === idx ? null : prev));
    if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
    setZoomCooldown(true);
    cooldownTimeoutRef.current = setTimeout(() => setZoomCooldown(false), 80);
    if (elevationTimeoutRef.current) clearTimeout(elevationTimeoutRef.current);
    setElevationGrace(true);
    elevationTimeoutRef.current = setTimeout(() => setElevationGrace(false), 250);
  }, []);

  const handleScale = useCallback((scale: number) => {
    currentScaleRef.current = scale;
  }, []);

  const isZoomActive = useCallback(
    () => zoomedIdx !== null || currentScaleRef.current > 1.01,
    [zoomedIdx],
  );

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length >= 2 || isZoomActive()) return;
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    touchDeltaX.current = 0;
    swipeAxisRef.current = "none";
    setIsSwiping(true);
  }, [isZoomActive]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isSwiping || e.touches.length >= 2 || isZoomActive()) return;
    const deltaX = e.touches[0].clientX - touchStartX.current;
    const deltaY = e.touches[0].clientY - touchStartY.current;

    // 이동 의도 판별 전에는 캐러셀을 움직이지 않는다. 임계값보다 작으면 아직 대기.
    if (swipeAxisRef.current === "none") {
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (absX < 8 && absY < 8) return;
      // 세로가 크면 페이지 세로 스크롤 의도 → 캐러셀 swipe 취소
      if (absY > absX) {
        swipeAxisRef.current = "vertical";
        setIsSwiping(false);
        setTranslateX(0);
        return;
      }
      swipeAxisRef.current = "horizontal";
    }

    if (swipeAxisRef.current === "vertical") return;

    touchDeltaX.current = deltaX;
    setTranslateX(deltaX);
  }, [isSwiping, isZoomActive]);

  const handleTouchEnd = useCallback(() => {
    swipeAxisRef.current = "none";
    if (!isSwiping) return;
    setIsSwiping(false);
    // swipe 시작 후 두 번째 손가락이 들어와 핀치로 전환됐다면 슬라이드 변경 무시
    if (isZoomActive()) {
      setTranslateX(0);
      return;
    }
    const threshold = 50;
    if (touchDeltaX.current < -threshold && current < slides.length - 1) {
      setCurrent((prev) => prev + 1);
    } else if (touchDeltaX.current > threshold && current > 0) {
      setCurrent((prev) => prev - 1);
    }
    setTranslateX(0);
  }, [current, isSwiping, isZoomActive, slides.length]);

  // Double-tap detection for mobile (줌 중일 땐 좋아요로 흘리지 않음)
  const handleTap = useCallback(() => {
    if (zoomedIdx !== null) return;
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      onDoubleTap();
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  }, [onDoubleTap, zoomedIdx]);

  const handleDoubleClick = useCallback(() => {
    if (zoomedIdx !== null) return;
    onDoubleTap();
  }, [onDoubleTap, zoomedIdx]);

  // 줌 활성 시 outer의 overflow-hidden은 fixed overlay를 클리핑하므로 풀어줌.
  // zoomCooldown 동안에도 풀어둔 상태 유지 — lib resetTransform 마지막 frame까지 부풀린 사진이 잘리지 않게.
  const outerClass = `relative w-full bg-bg-tertiary ${zoomedIdx !== null || zoomCooldown ? "" : "overflow-hidden"}`;

  // dim overlay는 outerClass div(transform 없는 부모) 자식으로 두어 fixed가 viewport 기준 동작.
  const dimOverlay = (
    <AnimatePresence>
      {zoomedIdx !== null && (
        <motion.div
          className="fixed inset-0 z-40 bg-black pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.15 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: "easeOut" }}
        />
      )}
    </AnimatePresence>
  );

  if (slides.length === 1) {
    return (
      <div
        className={outerClass}
        onDoubleClick={handleDoubleClick}
        onClick={handleTap}
      >
        {dimOverlay}
        <ZoomableSlide
          slide={slides[0]}
          elevationGrace={elevationGrace}
          onZoomChange={(z) => handleZoomChange(0, z)}
          onScale={handleScale}
          active
        />
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <div
        className={outerClass}
        onDoubleClick={handleDoubleClick}
        onClick={handleTap}
      >
        {dimOverlay}
        <div
          ref={containerRef}
          className="flex"
          style={{
            // 줌 중이라도 carousel transform은 그대로 유지 — 자리 줌이라 줌하던 슬라이드가 자기 자리에서 부풀어야 함.
            transform: `translateX(calc(-${current * 100}% + ${isSwiping ? translateX : 0}px))`,
            // 줌 중/swipe 중/줌 release cooldown에서는 transition off — 인라인 복귀 시 슬라이드 swoosh 방지
            transition: isSwiping || zoomedIdx !== null || zoomCooldown ? "none" : "transform 0.3s ease-out",
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {slides.map((slide, i) => (
            <div key={i} className="w-full flex-shrink-0 flex items-center justify-center">
              <ZoomableSlide
                slide={slide}
                elevationGrace={elevationGrace}
                onZoomChange={(z) => handleZoomChange(i, z)}
                onScale={handleScale}
                active={i === current}
              />
            </div>
          ))}
        </div>
      </div>
      {/* Dot indicators — 콘텐츠 아래(인스타처럼) + 별도 배경색 없이 카드 기본 배경 위에 */}
      <div className="flex justify-center gap-1.5 py-2.5">
        {slides.map((_, i) => (
          <div
            key={i}
            className={`w-1.5 h-1.5 rounded-full transition-colors ${
              i === current ? "bg-text-primary" : "bg-text-tertiary/40"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

/** Heart animation overlay for double-tap */
export function HeartOverlay({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.1 }}
        >
          <motion.span
            className="text-7xl drop-shadow-lg"
            initial={{ scale: 0.2, opacity: 0.8 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 1.4, opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            ❤️
          </motion.span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default function PhotoFeed({ posts, loading, onLike, sourceLabels, likedIds }: PhotoFeedProps) {
  const { user, profile } = useAuth();
  const canDeleteAnyPost = profile?.is_operator === true;
  const controlledLikes = likedIds !== undefined;
  const [likedPosts, setLikedPosts] = useState<Set<number>>(new Set());
  const [heartPostId, setHeartPostId] = useState<number | null>(null);
  const [commentPostId, setCommentPostId] = useState<number | null>(null);
  const [commentTeamId, setCommentTeamId] = useState<number | null>(null);
  // 댓글 추가 시 로컬 카운트 보정값
  const [commentDeltas, setCommentDeltas] = useState<Record<number, number>>({});
  // 게시글 메뉴 / 삭제 상태
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [shareTarget, setShareTarget] = useState<ShareSheetPost | null>(null);
  // 줌 활성 post id — post container의 overflow-hidden을 풀어 fixed overlay가 viewport까지 확장
  const [zoomedPostId, setZoomedPostId] = useState<number | null>(null);

  // poll 글의 목록 카드용 요약(배지·참여수·선지 미리보기) 배치 조회. poll 이 없으면 no-op.
  const [pollSummaries, setPollSummaries] = useState<Record<number, PollSummary>>({});
  const [pollResolved, setPollResolved] = useState<Set<number>>(new Set()); // 응답 받은 poll id(없으면 terminal)
  const [pollRetry, setPollRetry] = useState(0);
  const pollIdsKey = posts.filter((p) => p.board_type === "poll").map((p) => p.id).join(",");
  useEffect(() => {
    const ids = pollIdsKey ? pollIdsKey.split(",").map(Number) : [];
    if (ids.length === 0) return; // 남은 요약은 메모리에만 잔존(poll 아닌 글은 조회 안 함 — 내림)
    let alive = true;
    fetchPollSummaries(ids)
      .then((s) => {
        if (!alive) return;
        setPollSummaries((prev) => ({ ...prev, ...s })); // 부분 결과도 누적 merge(실패 chunk 카드만 terminal)
        setPollResolved((prev) => new Set([...prev, ...ids])); // 응답 받은 id 는 resolved(요약 없으면 '불러오기 실패')
      })
      .catch(() => {}); // fetchPollSummaries 는 chunk별 격리로 reject 안 하지만 방어적 catch
    return () => {
      alive = false;
    };
  }, [pollIdsKey, pollRetry]);

  // terminal 카드 재시도: 해당 id 를 로딩으로 되돌리고 배치 재조회 트리거.
  const retryPoll = useCallback((postId: number) => {
    setPollResolved((prev) => {
      const n = new Set(prev);
      n.delete(postId);
      return n;
    });
    setPollRetry((n) => n + 1);
  }, []);

  const handleDelete = useCallback(async (postId: number) => {
    setMenuOpenId(null);
    if (!confirm("이 게시글을 삭제할까요? 댓글/좋아요도 함께 삭제됩니다.")) return;
    try {
      await deletePost(postId, { canDeleteAny: canDeleteAnyPost });
      setDeletedIds(prev => { const n = new Set(prev); n.add(postId); return n; });
    } catch {
      alert("게시글 삭제에 실패했어요");
    }
  }, [canDeleteAnyPost]);

  const openComments = (post: Post) => {
    setCommentPostId(post.id);
    setCommentTeamId(post.team_id ?? null);
  };

  const handleShare = useCallback((post: Post) => {
    setShareTarget({
      id: post.id,
      title: post.title,
      content: post.content,
      videoUrl: post.video_urls?.[0] ?? null,
      board_type: post.board_type,
      board_id: post.board_id,
    });
  }, []);

  const handleLike = (postId: number) => {
    // controlled 모드에선 부모가 상태를 소유 → 내부 Set 건드리지 않고 onLike에 위임.
    if (!controlledLikes) {
      setLikedPosts((prev) => {
        const next = new Set(prev);
        if (next.has(postId)) next.delete(postId);
        else next.add(postId);
        return next;
      });
    }
    onLike(postId);
  };

  // Double-tap: always adds like (never removes), Instagram-style
  const handleDoubleTap = (postId: number) => {
    const alreadyLiked = controlledLikes ? likedIds!.has(postId) : likedPosts.has(postId);
    if (!alreadyLiked) {
      handleLike(postId);
    }
    // Show heart animation
    setHeartPostId(postId);
    setTimeout(() => setHeartPostId(null), 800);
  };

  if (loading) {
    return (
      <div className="divide-y divide-white/[0.02]">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="p-4 animate-pulse">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-bg-tertiary" />
              <div className="h-4 bg-bg-tertiary rounded w-24" />
            </div>
            <div className="w-full aspect-[4/5] bg-bg-tertiary" />
          </div>
        ))}
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
        <p className="text-base">아직 게시물이 없어요.</p>
        <p className="mt-1 text-sm">첫 게시물을 남겨보세요!</p>
      </div>
    );
  }

  return (
    <div>
      {posts.map((post, index) => {
        const isLiked = controlledLikes ? likedIds!.has(post.id) : likedPosts.has(post.id);
        const isMine = !!user && post.author_id === user.id;
        const hasMedia = post.image_urls.length > 0 || (post.video_urls?.length ?? 0) > 0;
        const body = mergedBody(post);
        const sourceLabel = sourceLabels ? getPostSourceLabel(post) : null;

        if (deletedIds.has(post.id)) return null;

        // poll 글: 질문 + 전용 카드(배지·참여수·선지 미리보기) + 작성자/like/comment/share.
        // 미디어/텍스트 카드 대신 PollCardBody 로 렌더. 탭 → 상세 이동.
        if (post.board_type === "poll") {
          const summary = pollSummaries[post.id];
          return (
            <div key={post.id}>
              {index > 0 && <div className="h-2 bg-white/[0.02]" />}
              <PostImpressionWrapper postId={post.id} className="overflow-hidden">
                <CommunityAuthorHeader
                  className="px-5 py-3"
                  nickname={post.nickname}
                  teamId={post.team_id}
                  avatarUrl={post.avatar_url}
                  profileHref={post.author_id ? `/profile/${post.author_id}` : null}
                  isStaff={post.grade === "staff"}
                  meta={<span className="text-xs text-text-tertiary">{timeAgo(post.created_at)}</span>}
                />

                {sourceLabel ? (
                  <div className="flex items-center gap-2 px-5 pb-2" data-community-source-label>
                    <span className="shrink-0 text-[10px] text-text-tertiary">글 소속</span>
                    {sourceLabel.teamId ? (
                      <TeamBadge teamId={sourceLabel.teamId} playerName={sourceLabel.playerName} size="sm" />
                    ) : (
                      <span className="min-w-0 truncate rounded-full bg-bg-tertiary px-2.5 py-1 text-sm font-bold text-text-primary">
                        {sourceLabel.text}
                      </span>
                    )}
                  </div>
                ) : null}

                {/* 질문 + poll 카드 → 탭 시 상세 이동 */}
                <Link href={`/community/free/${post.id}`} className="block px-5 pb-1 active:opacity-90">
                  {post.title && (
                    <h3 className="text-base font-semibold text-text-primary line-clamp-2">{post.title}</h3>
                  )}
                  <PollCardSlot
                    summary={summary}
                    loaded={pollResolved.has(post.id)}
                    onRetry={() => retryPoll(post.id)}
                  />
                </Link>

                {/* Action bar (like/comment/share) */}
                <div className="flex items-center gap-4 px-5 py-2.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleLike(post.id);
                    }}
                    className="flex items-center gap-1 text-base transition-colors"
                  >
                    <span className="text-xl leading-none">{isLiked ? "❤️" : "♡"}</span>
                    <span className={isLiked ? "text-red-500 font-medium" : "text-text-secondary"}>
                      {post.like_count + (controlledLikes ? 0 : isLiked ? 1 : 0)}
                    </span>
                  </button>
                  <button onClick={() => openComments(post)} className="flex items-center gap-1 text-base text-text-secondary">
                    <MessageCircle size={20} />
                    <span>{post.comment_count + (commentDeltas[post.id] ?? 0)}</span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleShare(post);
                    }}
                    className="ml-auto flex items-center gap-1 text-base text-text-secondary"
                    aria-label="게시글 공유"
                  >
                    <Share2 size={20} />
                    <span className="sr-only">공유</span>
                  </button>
                  <PostViewBadge
                    clickCount={post.click_view_count}
                    impressionCount={post.impression_view_count}
                    className="ml-2"
                  />
                </div>
              </PostImpressionWrapper>
            </div>
          );
        }

        return (
          <div key={post.id}>
            {/* Post separator */}
            {index > 0 && <div className="h-2 bg-white/[0.02]" />}

            <PostImpressionWrapper
              postId={post.id}
              className={zoomedPostId === post.id ? "" : "overflow-hidden"}
            >
              <CommunityAuthorHeader
                className="px-5 py-3"
                nickname={post.nickname}
                teamId={post.team_id}
                avatarUrl={post.avatar_url}
                profileHref={post.author_id ? `/profile/${post.author_id}` : null}
                isStaff={post.grade === "staff"}
                meta={
                  <span className="text-xs text-text-tertiary">
                    {timeAgo(post.created_at)}{post.updated_at ? " · 수정됨" : ""}
                  </span>
                }
                menu={(isMine || canDeleteAnyPost) ? (
                  <div className="relative">
                    <button
                      onClick={(e) => { e.stopPropagation(); setMenuOpenId(prev => prev === post.id ? null : post.id); }}
                      className="p-1 text-text-tertiary hover:text-text-primary"
                      aria-label="게시글 메뉴"
                    >
                      <MoreHorizontal size={20} />
                    </button>
                    {menuOpenId === post.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setMenuOpenId(null)} />
                        <div className="absolute right-0 top-8 z-20 min-w-[112px] overflow-hidden rounded-lg border border-border bg-bg-primary shadow-lg">
                          <button
                            onClick={() => handleDelete(post.id)}
                            className="block w-full px-3 py-2 text-left text-sm text-[#FF453A] hover:bg-bg-tertiary"
                          >
                            삭제
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              />

              {/* 혼합 피드에서만 작성자 응원팀과 별개인 콘텐츠 소속을 표시한다. */}
              {sourceLabel ? (
                <div className="flex items-center gap-2 px-5 pb-2" data-community-source-label>
                  <span className="shrink-0 text-[10px] text-text-tertiary">글 소속</span>
                  {sourceLabel.teamId ? (
                    <TeamBadge teamId={sourceLabel.teamId} playerName={sourceLabel.playerName} size="sm" />
                  ) : (
                    <span className="min-w-0 truncate rounded-full bg-bg-tertiary px-2.5 py-1 text-sm font-bold text-text-primary">
                      {sourceLabel.text}
                    </span>
                  )}
                </div>
              ) : null}

              {/* 본문 슬롯 — 미디어(카드 A) / 짧은 글(카드 B) / 긴 글(카드 C) 분기 */}
              {hasMedia ? (
                /* 사진/영상 캐러셀 — full bleed, no padding, no rounded corners */
                <div className="relative">
                  <PhotoCarousel
                    slides={[
                      ...post.image_urls.map((url) => ({ url, isVideo: false })),
                      ...(post.video_urls ?? []).map((url) => ({ url, isVideo: true })),
                    ]}
                    onDoubleTap={() => handleDoubleTap(post.id)}
                    onZoomActiveChange={(active) =>
                      setZoomedPostId((prev) => (active ? post.id : prev === post.id ? null : prev))
                    }
                  />
                  <HeartOverlay show={heartPostId === post.id} />
                </div>
              ) : body && isShortText(body) ? (
                <BrandedTextCard post={post} body={body} />
              ) : body ? (
                <BrandedTextCard post={post} body={body} long />
              ) : null}

              {/* Action bar */}
              <div className="flex items-center gap-4 px-5 py-2.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLike(post.id);
                  }}
                  className="flex items-center gap-1 text-base transition-colors"
                >
                  <span className="text-xl leading-none">{isLiked ? "\u2764\uFE0F" : "\u2661"}</span>
                  <span className={isLiked ? "text-red-500 font-medium" : "text-text-secondary"}>
                    {/* controlled 모드: 부모가 like_count를 이미 optimistic 보정 → 그대로 표시. uncontrolled: 내부 하트 기준 +1 */}
                    {post.like_count + (controlledLikes ? 0 : isLiked ? 1 : 0)}
                  </span>
                </button>
                <button
                  onClick={() => openComments(post)}
                  className="flex items-center gap-1 text-base text-text-secondary"
                >
                  <MessageCircle size={20} />
                  <span>{post.comment_count + (commentDeltas[post.id] ?? 0)}</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleShare(post);
                  }}
                  className="ml-auto flex items-center gap-1 text-base text-text-secondary"
                  aria-label="게시글 공유"
                >
                  <Share2 size={20} />
                  <span className="sr-only">공유</span>
                </button>
                <PostViewBadge
                  clickCount={post.click_view_count}
                  impressionCount={post.impression_view_count}
                  className="ml-2"
                />
              </div>

              {/* Caption — 미디어 카드에만 (텍스트 카드는 본문이 카드 자체).
                  작성자 본문만 1줄로 노출(피드에선 타 댓글 프리뷰 미표시) → 전체는 댓글 시트. */}
              {hasMedia && body && (
                <CaptionBlock
                  nickname={post.nickname || "익명"}
                  content={body}
                  onPress={() => openComments(post)}
                />
              )}

              {/* Hashtags */}
              {post.hashtags && Array.isArray(post.hashtags) && post.hashtags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-5 pb-1">
                  {(post.hashtags as string[]).map((tag: string) => (
                    <span key={tag} className="text-xs text-accent font-medium">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </PostImpressionWrapper>
          </div>
        );
      })}
      {commentPostId !== null && (
        <CommentSheet
          isOpen={true}
          onClose={() => { setCommentPostId(null); setCommentTeamId(null); }}
          postId={commentPostId}
          teamId={commentTeamId}
          onCommentAdded={(postId) => {
            setCommentDeltas((prev) => ({ ...prev, [postId]: (prev[postId] ?? 0) + 1 }));
          }}
          onCommentDeleted={(postId, removedCount = 1) => {
            setCommentDeltas((prev) => ({ ...prev, [postId]: (prev[postId] ?? 0) - removedCount }));
          }}
        />
      )}
      <ShareSheet isOpen={shareTarget !== null} post={shareTarget} onClose={() => setShareTarget(null)} />
    </div>
  );
}

/** 인스타 스타일 캡션: 1줄 초과 시 "더보기" / 펼친 후 클릭하면 접기 */
function CaptionBlock({ nickname, content, onPress }: { nickname: string; content: string; onPress: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  // 움짤콜렉터 자동 출처 "(출처: …)\n{url}"는 본문에서 분리해 원문 하이퍼링크로 렌더.
  const attr = parseAttribution(content);
  const bodyText = attr ? attr.body : content;

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // line-clamp가 적용된 상태에서 높이 비교로 clamped 판단
    // 약간의 딜레이를 줘서 렌더 후 측정
    requestAnimationFrame(() => {
      setClamped(el.scrollHeight > el.clientHeight + 2);
    });
  }, [content]);

  return (
    <div className="px-5 pb-1">
      <div
        ref={textRef}
        role="button"
        tabIndex={0}
        onClick={expanded ? () => setExpanded(false) : clamped ? () => setExpanded(true) : onPress}
        className={`text-left text-base cursor-pointer ${!expanded ? "line-clamp-1" : ""}`}
      >
        <span className="font-semibold text-text-primary mr-1.5">{nickname}</span>
        {bodyText && <span className="text-text-secondary">{bodyText}</span>}
        {attr && (
          <span className="text-text-secondary">
            {` (출처: ${attr.handle ? attr.label + " " : ""}`}
            <a
              href={attr.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-accent"
            >
              {attr.handle ? `@${attr.handle}` : attr.label}
            </a>
            {")"}
          </span>
        )}
      </div>
      {clamped && !expanded && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
          className="text-base text-text-tertiary mt-0.5"
        >
          더보기
        </button>
      )}
    </div>
  );
}
