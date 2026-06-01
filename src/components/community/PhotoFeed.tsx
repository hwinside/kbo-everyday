"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { MessageCircle, MoreHorizontal, Volume2, VolumeX } from "lucide-react";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { getTeamById, getTeamBySlug, getTeamBgColor, type TeamData } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import { parsePlayerTag } from "@/lib/utils/player-tags";

// Hero cutout: 검수 통과(allowlist) 선수만 노출. public/players-hero/{kboId}.webp
const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);
function getPlayerHeroPath(kboId: string | null | undefined): string | null {
  return kboId && HERO_APPROVED.has(kboId) ? `/players-hero/${kboId}.webp` : null;
}
import TeamBadge from "@/components/ui/TeamBadge";
import type { Post } from "@/lib/supabase/usePosts";
import { deletePost } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";
import type { CommunitySourceLabel } from "@/lib/utils/community-board";
import CommentSheet from "./CommentSheet";
import LinkPreview from "./LinkPreview";

function findPlayerByName(name: string): { kboId: string; teamId: number } | null {
  for (const p of PLAYERS_ROSTER) {
    if (p.name === name) return { kboId: p.kboId, teamId: p.teamId };
  }
  return null;
}

function findPlayerByKboId(kboId: string): { teamId: number } | null {
  for (const p of PLAYERS_ROSTER) {
    if (p.kboId === kboId) return { teamId: p.teamId };
  }
  return null;
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

// 본문 내 링크 매칭(PostCard와 동일 패턴). test용은 non-global, strip용은 global.
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/;
const URL_REGEX_G = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/g;

/** URL을 제거한 본문 — 짧은글 판정/표시에 사용(OG 카드가 링크를 대신 노출). */
function stripUrls(text: string): string {
  return text.replace(URL_REGEX_G, "").replace(/\n{3,}/g, "\n\n").trim();
}

function hasLink(text: string): boolean {
  return URL_REGEX.test(text);
}

/**
 * 배경 텍스트 카드(B) 조건: 첨부 0(호출부 보장) + URL 제거 본문 ≤ 80자.
 * 링크/OG만 달랑 있는 OG-only 글(하린아빠 확정 예외)도 LongTextCard로 빠지지 않고
 * 배경카드 유지 → BrandedTextCard 내부에서 카드 위에 OG 프리뷰 노출 + 본문 URL strip.
 */
function isShortText(body: string): boolean {
  return stripUrls(body).length <= 80;
}


interface MediaSlide {
  url: string;
  isVideo: boolean;
}

// 화면에 동영상이 2개 이상 떠 있을 때 가운데로 가장 많이 보이는 1개만 재생.
// iOS Safari가 동시 muted-autoplay를 막아 "재생 안 됨"으로 보이던 문제도 함께 해소.
const videoRegistry = new Set<HTMLVideoElement>();
const videoRatio = new Map<HTMLVideoElement, number>();
let videoObserver: IntersectionObserver | null = null;
let videoRecomputeScheduled = false;
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

function recomputeVideoFocus() {
  let best: HTMLVideoElement | null = null;
  let bestRatio = 0;
  videoRegistry.forEach((el) => {
    const r = videoRatio.get(el) ?? 0;
    if (r > bestRatio) {
      bestRatio = r;
      best = el;
    }
  });
  videoRegistry.forEach((el) => {
    if (el === best && bestRatio >= VIDEO_MIN_VISIBLE) {
      el.play().catch(() => {});
    } else if (!el.paused) {
      el.pause();
    }
  });
}

function ensureVideoObserver(): IntersectionObserver {
  if (videoObserver) return videoObserver;
  videoObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => videoRatio.set(e.target as HTMLVideoElement, e.intersectionRatio));
      if (!videoRecomputeScheduled) {
        videoRecomputeScheduled = true;
        requestAnimationFrame(() => {
          videoRecomputeScheduled = false;
          recomputeVideoFocus();
        });
      }
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] },
  );
  return videoObserver;
}

function FeedVideo({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useGlobalVideoMuted();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = ensureVideoObserver();
    videoRegistry.add(el);
    observer.observe(el);
    return () => {
      observer.unobserve(el);
      videoRegistry.delete(el);
      videoRatio.delete(el);
      recomputeVideoFocus();
    };
  }, []);

  // 전역 음소거 상태를 element에 반영. React의 muted 속성은 property 반영이 불안정해 직접 세팅.
  // 소리를 켠 직후 포커스된 영상은 사용자 제스처 컨텍스트라 iOS에서도 사운드 재생이 허용된다.
  useEffect(() => {
    const el = ref.current;
    if (el) el.muted = muted;
  }, [muted]);

  return (
    <div className="relative w-full">
      <video
        ref={ref}
        src={url}
        muted={muted}
        loop
        playsInline
        preload="metadata"
        className="w-full object-contain pointer-events-none select-none bg-black"
        style={{ maxHeight: "80vh", WebkitTouchCallout: "none" } as React.CSSProperties}
      />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setMuted(!muted); }}
        className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm pointer-events-auto"
        aria-label={muted ? "소리 켜기" : "소리 끄기"}
      >
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
    </div>
  );
}

function MediaElement({ url, isVideo, sizes }: { url: string; isVideo: boolean; sizes?: string }) {
  const isGif = !isVideo && url.toLowerCase().endsWith(".gif");

  if (isVideo) {
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
}: {
  slide: MediaSlide;
  // zoom 종료 직후 dim overlay exit fade(0.24s) 동안 wrapper z-elevation을 유지하기 위한 grace 신호.
  // 부모(PhotoCarousel)가 dim exit와 같은 길이로 켰다 끄는 별도 state(zoomCooldown 80ms와 분리).
  elevationGrace: boolean;
  onZoomChange: (zoomed: boolean) => void;
  onScale: (scale: number) => void;
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
    return <MediaElement url={slide.url} isVideo={slide.isVideo} />;
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

function PhotoCarousel({
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
            <div key={i} className="w-full flex-shrink-0">
              <ZoomableSlide
                slide={slide}
                elevationGrace={elevationGrace}
                onZoomChange={(z) => handleZoomChange(i, z)}
                onScale={handleScale}
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
function HeartOverlay({ show }: { show: boolean }) {
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

export default function PhotoFeed({ posts, loading, onLike, boardType = "team", playerLabels, sourceLabels, likedIds }: PhotoFeedProps) {
  const { user } = useAuth();
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
  // 줌 활성 post id — post container의 overflow-hidden을 풀어 fixed overlay가 viewport까지 확장
  const [zoomedPostId, setZoomedPostId] = useState<number | null>(null);

  const handleDelete = useCallback(async (postId: number) => {
    setMenuOpenId(null);
    if (!confirm("이 게시글을 삭제할까요? 댓글/좋아요도 함께 삭제됩니다.")) return;
    try {
      await deletePost(postId);
      setDeletedIds(prev => { const n = new Set(prev); n.add(postId); return n; });
    } catch {
      alert("게시글 삭제에 실패했어요");
    }
  }, []);

  const openComments = (post: Post) => {
    setCommentPostId(post.id);
    setCommentTeamId(post.team_id ?? null);
  };

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
        // 태그 기반(V3): 팀/전체 피드에서 선수 태그가 달린 글은 배경 틴트로 "선수 글"임을 구분.
        // 선수 페이지(boardType==="player")에선 전부 선수 글이라 틴트 불필요.
        const isPlayerPost =
          boardType !== "player" && Array.isArray(post.player_tags) && post.player_tags.length > 0;

        if (deletedIds.has(post.id)) return null;

        return (
          <div key={post.id}>
            {/* Post separator */}
            {index > 0 && <div className="h-2 bg-white/[0.02]" />}

            <div
              className={`${zoomedPostId === post.id ? "" : "overflow-hidden"}${
                isPlayerPost ? " bg-accent/[0.06] border-l-2 border-accent/40" : ""
              }`}
            >
              {/* Author header — 일반게시판(PostCard) 기준 통일 */}
              <div className="flex items-center gap-3 px-5 py-3">
                {boardType === "player" && playerLabels?.[post.id] ? (
                  <TeamBadge teamId={playerLabels[post.id].teamId} playerName={playerLabels[post.id].playerName} />
                ) : (
                  post.team_id ? <TeamBadge teamId={post.team_id} /> : null
                )}
                <span className="text-base font-medium text-text-primary truncate">
                  {post.nickname || "익명"}
                </span>
                {post.grade === "staff" && (
                  <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-accent/20 text-accent rounded-full">
                    운영팀
                  </span>
                )}
                <span className="ml-auto text-base text-text-tertiary flex-shrink-0">
                  {timeAgo(post.created_at)}{post.updated_at ? " · 수정됨" : ""}
                </span>
                {isMine && (
                  <div className="relative flex-shrink-0">
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
                        <div className="absolute right-0 top-8 z-20 min-w-[112px] rounded-lg border border-border bg-bg-primary shadow-lg overflow-hidden">
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
                )}
              </div>

              {sourceLabels?.[post.id] && (
                <div className="px-5 pb-2">
                  {sourceLabels[post.id].teamId ? (
                    <TeamBadge
                      teamId={sourceLabels[post.id].teamId!}
                      playerName={sourceLabels[post.id].playerName}
                      size="xs"
                    />
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">
                      {sourceLabels[post.id].text}
                    </span>
                  )}
                </div>
              )}

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
                <LongTextCard body={body} />
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

              {/* Player tags — clickable, links to player page */}
              {post.player_tags && Array.isArray(post.player_tags) && post.player_tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-5 pb-1">
                  {(post.player_tags as string[]).map((tag: string) => {
                    const { kboId, displayName } = parsePlayerTag(tag);

                    let href: string | undefined;
                    let team: ReturnType<typeof getTeamById> = undefined;

                    if (kboId) {
                      // New format: kboId directly available
                      href = `/community/players/${kboId}`;
                      const rosterEntry = findPlayerByKboId(kboId);
                      team = rosterEntry ? getTeamById(rosterEntry.teamId) : undefined;
                    } else {
                      // Legacy name-only fallback
                      const player = findPlayerByName(displayName);
                      if (player) {
                        href = `/community/players/${player.kboId}`;
                        team = getTeamById(player.teamId);
                      }
                    }

                    const label = team ? `@${team.shortName} ${displayName}` : `@${displayName}`;

                    return href ? (
                      <Link key={tag} href={href} className="text-xs font-medium text-text-secondary bg-bg-tertiary px-2 py-0.5 rounded-full active:bg-bg-quaternary transition-colors">
                        {label}
                      </Link>
                    ) : (
                      <span key={tag} className="text-xs font-medium text-text-secondary bg-bg-tertiary px-2 py-0.5 rounded-full">
                        {label}
                      </span>
                    );
                  })}
                </div>
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
            </div>
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
          onCommentDeleted={(postId) => {
            setCommentDeltas((prev) => ({ ...prev, [postId]: (prev[postId] ?? 0) - 1 }));
          }}
        />
      )}
    </div>
  );
}

/**
 * 카드 배경 컨텍스트(V3 태그 기반) — 팀컬러 + 선수 Hero 결정.
 * - 선수 1명 태그 → 그 선수 팀컬러 BG + 그 선수 Hero(우하단)
 * - 선수 2명↑ 태그 → 모두 같은 팀이면 팀컬러 BG(단일 Hero 없음), 다른 팀 섞이면 기본 BG
 * - 선수 태그 없음 → (레거시 board_type / 자유글 작성자팀)으로 폴백
 */
function deriveBrandContext(post: Post): { team?: TeamData; heroKboId?: string } {
  const playerTags = Array.isArray(post.player_tags) ? (post.player_tags as string[]) : [];
  if (playerTags.length > 0) {
    const parsed = playerTags.map((t) => {
      const { kboId, displayName } = parsePlayerTag(t);
      if (kboId) return { kboId, teamId: findPlayerByKboId(kboId)?.teamId };
      const p = findPlayerByName(displayName);
      return { kboId: p?.kboId, teamId: p?.teamId };
    });
    if (playerTags.length === 1) {
      const only = parsed[0];
      return { team: only.teamId ? getTeamById(only.teamId) : undefined, heroKboId: only.kboId ?? undefined };
    }
    const teamIds = new Set(parsed.map((p) => p.teamId).filter((x): x is number => !!x));
    if (teamIds.size === 1) return { team: getTeamById([...teamIds][0]) };
    return {}; // 다른 팀 혼합 → 기본 BG
  }
  // 레거시 board 기반(player_tags 없는 기존 글)
  if (post.board_type === "team") return { team: getTeamBySlug(post.board_id) };
  if (post.board_type === "player") {
    const entry = findPlayerByKboId(post.board_id);
    return { team: entry ? getTeamById(entry.teamId) : undefined, heroKboId: post.board_id };
  }
  // 자유게시판 → 작성자 응원팀 컬러(없으면 중립)
  return { team: post.team_id ? getTeamById(post.team_id) : undefined };
}

/** 카드 B — 페북식 배경 텍스트 카드. 태그 기반으로 팀컬러 + 선수 Hero(우하단) 결정. */
function BrandedTextCard({ post, body }: { post: Post; body: string }) {
  const { team, heroKboId } = deriveBrandContext(post);
  const heroPath = getPlayerHeroPath(heroKboId);

  const gradient = team
    ? `linear-gradient(135deg, color-mix(in srgb, ${getTeamBgColor(team)} 35%, #1a1a1d) 0%, #1a1a1d 100%)`
    : "linear-gradient(135deg, #2a2a3d 0%, #1a1a1d 100%)";

  // OG-only 예외: URL은 본문에서 strip하고 OG 프리뷰를 카드 위에 노출(하린아빠 확정).
  const displayBody = stripUrls(body);
  const linked = hasLink(body);

  return (
    <div
      className="relative flex min-h-[200px] w-full items-center justify-center overflow-hidden px-8 py-10"
      style={{ background: gradient }}
    >
      {heroPath ? (
        // 선수 1명 태그 → 팀컬러 BG 위에 선수 Hero 우하단(팀글의 로고 자리 대신 인물 컷아웃)
        <Image
          src={heroPath}
          alt=""
          width={200}
          height={240}
          unoptimized
          // 30% 축소(h 88%→62%) + 반투명 + 좌상단 페이드 마스크 → 팀 로고처럼 배경에 스며드는 느낌(①).
          className="pointer-events-none absolute bottom-0 right-0 h-[62%] w-auto object-contain object-bottom"
          style={{
            opacity: 0.4,
            maskImage: "linear-gradient(to top left, #000 50%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to top left, #000 50%, transparent 100%)",
          }}
        />
      ) : team ? (
        <div className="absolute right-4 top-4 opacity-20">
          <Image src={team.logoPath} alt="" width={88} height={88} unoptimized className="object-contain" />
        </div>
      ) : null}
      <div className="relative z-10 flex w-full flex-col items-center gap-3">
        {displayBody && (
          <p className="whitespace-pre-line break-keep text-center text-xl font-bold leading-snug text-white line-clamp-5">
            {displayBody}
          </p>
        )}
        {linked && (
          <div className="w-full max-w-sm">
            <LinkPreview text={body} maxPreviews={1} stopPropagation />
          </div>
        )}
      </div>
    </div>
  );
}

/** 카드 C — 긴 텍스트. 3줄 클램프 + '더 보기' 인라인 펼침(상세 이동 없음). 링크 포함 시 OG 프리뷰. */
function LongTextCard({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  // 본문에서 URL은 strip하고 OG 카드로 대신 노출(짧은글 BrandedTextCard와 동일 규칙).
  // 기존엔 긴 글 분기에 OG 카드가 아예 없어 "텍스트 길고 링크 포함 글에서 OG 안뜸" 버그였음.
  const displayBody = stripUrls(body);
  const linked = hasLink(body);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    requestAnimationFrame(() => setClamped(el.scrollHeight > el.clientHeight + 2));
  }, [displayBody]);

  return (
    <div className="px-5 pt-1 pb-2">
      {displayBody && (
        <>
          <p
            ref={ref}
            className={`whitespace-pre-line break-words text-base leading-relaxed text-text-primary ${expanded ? "" : "line-clamp-3"}`}
          >
            {displayBody}
          </p>
          {clamped && !expanded && (
            <button onClick={() => setExpanded(true)} className="mt-0.5 text-base text-text-tertiary">
              더 보기
            </button>
          )}
        </>
      )}
      {linked && (
        <div className="mt-2 max-w-sm">
          <LinkPreview text={body} maxPreviews={1} stopPropagation />
        </div>
      )}
    </div>
  );
}

/** 인스타 스타일 캡션: 1줄 초과 시 "더보기" / 펼친 후 클릭하면 접기 */
function CaptionBlock({ nickname, content, onPress }: { nickname: string; content: string; onPress: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

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
        <span className="text-text-secondary">{content}</span>
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
