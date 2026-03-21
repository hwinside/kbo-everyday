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

export default function PullToRefresh({ onRefresh, children, className }: PullToRefreshProps) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const startYRef = useRef(0);
  const isPullingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (isRefreshing) return;
    const container = containerRef.current;
    if (!container || container.scrollTop > 0) return;
    startYRef.current = e.touches[0].clientY;
    isPullingRef.current = true;
  }, [isRefreshing]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isPullingRef.current || isRefreshing) return;
    const container = containerRef.current;
    if (!container || container.scrollTop > 0) {
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
      {/* Pull indicator */}
      <div
        className="flex items-center justify-center overflow-hidden transition-[height] duration-150 ease-out"
        style={{ height: pullDistance > 5 ? pullDistance : 0 }}
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
