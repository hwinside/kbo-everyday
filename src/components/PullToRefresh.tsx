"use client";

import { useRef, useState, useCallback, type ReactNode } from "react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  /** Container className override */
  className?: string;
}

const THRESHOLD = 60; // px to trigger refresh
const MAX_PULL = 100; // max pull distance

/**
 * 당김 인디케이터 고정 오버레이의 z-index.
 * stacking 계약(삼순 #939 재리뷰 조건): 모든 페이지 sticky 헤더 위 · 전체화면 레이어 아래.
 *   - 홈 헤더  sticky z-30
 *   - 경기상세 GameDetailHeader sticky z-[100]  ← 인디케이터가 반드시 이보다 위여야 함
 *   - 전체화면 모달/오버레이 z-[110]·[120]·[130], 풀스크린 뷰어 z-[10000]+  ← 인디케이터가 이보다 아래여야 함
 * 105 = (100, 110) 구간 중간. GameDetailHeader/모달 z를 바꾸면 이 불변식을 지키도록 같이 갱신.
 */
export const PTR_INDICATOR_Z = 105;
/** 페이지 sticky 헤더 z 상한(이보다 인디케이터가 높아야 함) */
export const PTR_MAX_STICKY_HEADER_Z = 100;
/** 전체화면 모달/오버레이 z 하한(이보다 인디케이터가 낮아야 함) */
export const PTR_MIN_FULLSCREEN_OVERLAY_Z = 110;

/**
 * 당김 제스처 arm 여부 — 터치가 시작된 노드가 입력/모달/중첩 스크롤러면 버블링으로
 * 상위 pull-to-refresh가 오발동해 key remount·미저장 입력 유실이 난다(삼순 #731 NO-GO).
 * 순수 판정(DOM 분리): 페이지 최상단 일반 콘텐츠에서 시작한 pull만 arm한다.
 */
export interface PullStartNodeFlags {
  tag: string; // uppercase tagName
  contentEditable?: boolean;
  role?: string | null;
  ariaModal?: boolean; // aria-modal="true"
  position?: string; // computed position (fixed 모달/오버레이 루트)
  overflowY?: string; // computed overflow-y
}

// 핵심: overflow-y auto/scroll은 현재 스크롤 양(scrollHeight>clientHeight) 무관하게 차단.
// (삼순 #731 2차 NO-GO: 모달 패딩 DIV가 overflowY=auto지만 scrollHeight===clientHeight라
//  이전 "실제 스크롤 가능" 게이트를 통과해 pull이 모달을 날렸다.)
export function nodeBlocksPull(f: PullStartNodeFlags): boolean {
  if (f.tag === "INPUT" || f.tag === "TEXTAREA" || f.tag === "SELECT") return true;
  if (f.contentEditable) return true;
  if (f.role === "dialog") return true;
  if (f.ariaModal) return true;
  if (f.position === "fixed") return true;
  if (f.overflowY === "auto" || f.overflowY === "scroll") return true;
  return false;
}

// e.target에서 container 전까지 조상을 올라가며 중첩 입력/모달/스크롤러 감지.
// 시작 타입은 Element(SVG 포함) — Lucide 아이콘 <svg>/<path>는 HTMLElement가 아니므로
// HTMLElement로 좀히면 walker가 즉시 null로 끝나 부모 modal/fixed/overflow를 전부 우회한다(삼순 #731 3차 NO-GO).
export function pullStartIsBlocked(target: EventTarget | null, container: HTMLElement): boolean {
  let node: Element | null = target instanceof Element ? target : null;
  while (node && node !== container) {
    const style = window.getComputedStyle(node);
    if (
      nodeBlocksPull({
        tag: node.tagName,
        contentEditable: node instanceof HTMLElement ? node.isContentEditable : false,
        role: node.getAttribute("role"),
        ariaModal: node.getAttribute("aria-modal") === "true",
        position: style.position,
        overflowY: style.overflowY,
      })
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

export default function PullToRefresh({ onRefresh, children, className }: PullToRefreshProps) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const startYRef = useRef(0);
  const isPullingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (isRefreshing) return;
    const container = containerRef.current;
    if (!container) return;
    // Support both scrollable containers (overflow-y-auto) and page-level scroll
    const scrolled = container.scrollTop > 0 || window.scrollY > 0;
    if (scrolled) return;
    // 중첩 입력/모달/스크롤러에서 시작한 제스처는 arm하지 않는다(삼순 #731 NO-GO).
    if (pullStartIsBlocked(e.target, container)) return;
    startYRef.current = e.touches[0].clientY;
    isPullingRef.current = true;
  }, [isRefreshing]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isPullingRef.current || isRefreshing) return;
    const container = containerRef.current;
    if (!container || container.scrollTop > 0 || window.scrollY > 0) {
      isPullingRef.current = false;
      setPullDistance(0);
      return;
    }
    const deltaY = e.touches[0].clientY - startYRef.current;
    if (deltaY > 0) {
      // Damped pull (diminishing returns)
      const distance = Math.min(deltaY * 0.4, MAX_PULL);
      setPullDistance(distance);
    } else {
      setPullDistance(0);
    }
  }, [isRefreshing]);

  const handleTouchEnd = useCallback(async () => {
    if (!isPullingRef.current || isRefreshing) return;
    isPullingRef.current = false;
    if (pullDistance >= THRESHOLD) {
      setIsRefreshing(true);
      setPullDistance(THRESHOLD * 0.6); // Hold at smaller height during refresh
      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, isRefreshing, onRefresh]);

  const progress = Math.min(pullDistance / THRESHOLD, 1);

  return (
    <div
      ref={containerRef}
      className={className}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Pull indicator — 스티키 헤더 위에 뜨는 고정 오버레이.
          #917에서 홈 헤더가 sticky top-0 z-30, 경기상세 GameDetailHeader는 sticky z-[100]로
          바뀌면서 in-flow 인디케이터를 헤더가 덮어 스피너가 안 보이던 회귀 수정.
          stacking 계약: 인디케이터 z=PTR_INDICATOR_Z(105)로 모든 페이지 sticky 헤더
          (홈 z-30·경기상세 z-[100]) 위에 두되, z-[110]+ 전체화면 모달/오버레이
          (모달 z-[110~130]·풀스크린 뷰어 z-[10000]+)보다는 아래에 둔다(삼순 #939 NO-GO).
          페이지 스크롤(window)과 무관하게 당김 중에만 상단 고정 밴드로 노출. */}
      <div
        className="pointer-events-none fixed left-0 right-0 flex items-center justify-center overflow-hidden bg-bg-primary transition-[height] duration-150 ease-out"
        style={{
          top: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
          height: pullDistance > 5 ? pullDistance : 0,
          zIndex: PTR_INDICATOR_Z,
        }}
      >
        <div className="flex items-center gap-2">
          {isRefreshing ? (
            <div className="w-5 h-5 border-2 border-text-tertiary border-t-accent rounded-full animate-spin" />
          ) : (
            <svg
              className="w-5 h-5 text-text-tertiary transition-transform duration-150"
              style={{ transform: `rotate(${progress * 180}deg)`, opacity: progress }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          )}
          <span
            className="text-xs text-text-tertiary transition-opacity duration-150"
            style={{ opacity: progress }}
          >
            {isRefreshing ? "업데이트 중..." : progress >= 1 ? "놓으면 새로고침" : "당겨서 새로고침"}
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}
