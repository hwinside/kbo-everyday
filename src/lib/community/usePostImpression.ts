"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { currentViewerKey, canCountImpression, trackPostImpressionOncePerSession } from "./view-tracker";

/**
 * 피드 카드 임프레션 트래킹 훅.
 *
 * 반환된 ref를 카드 최상위 엘리먼트에 걸면, 그 카드의 세로 ≥50%가 뷰포트에 들어오고
 * 0.5초 이상 머무를 때 임프레션 1회 집계(세션당 글 1회). 빠른 스크롤은 미집계.
 *
 * 주의: 매우 긴 카드(뷰포트 2배 초과)는 intersectionRatio가 0.5에 도달 못 할 수 있음
 * — 슬라이스1 범위에선 피드 카드가 80vh로 캡되므로 실무상 문제 없음.
 */
export function usePostImpression<T extends HTMLElement = HTMLDivElement>(postId: number) {
  const ref = useRef<T | null>(null);
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!Number.isInteger(postId) || postId <= 0) return;
    // auth 복원 중엔 관찰하지 않는다 — loading 중 user=null을 게스트로 잡아 1회 찍힌 뒤
    // 로그인이 복원되면 같은 사람이 user키로 또 1회(=이중 집계)되는 것 방지(삼순 blocker1).
    if (authLoading) return;
    const viewerKey = currentViewerKey(userId);
    if (!canCountImpression(postId, viewerKey)) return; // 동일 유저 세션당 1회
    if (typeof IntersectionObserver === "undefined") return;

    let dwellTimer: ReturnType<typeof setTimeout> | null = null;

    const clearDwell = () => {
      if (dwellTimer) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        if (e.intersectionRatio >= 0.5) {
          if (dwellTimer) return; // 이미 dwell 카운트 중
          dwellTimer = setTimeout(() => {
            dwellTimer = null;
            if (!canCountImpression(postId, viewerKey)) return;
            trackPostImpressionOncePerSession(postId, userId);
            io.disconnect();
          }, 500);
        } else {
          clearDwell(); // 50% 밑으로 내려가면 dwell 취소(휙 지나감)
        }
      },
      { threshold: [0, 0.5, 1] },
    );

    io.observe(el);
    return () => {
      clearDwell();
      io.disconnect();
    };
  }, [postId, userId, authLoading]);

  return ref;
}
