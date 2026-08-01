"use client";

import { useEffect, useRef } from "react";
import { saveFeedRestore } from "@/lib/community/feed-restore";

/**
 * 피드 페이지에 붙이는 스크롤 복원 훅.
 *
 *  - 페이지를 떠나기 직전(스크롤/pagehide/언마운트) 현재 스크롤 + 로드 페이지 수를 저장한다.
 *  - `useUnifiedFeed`가 복원 페이지를 다 채우고 `pendingScrollY`를 넘겨주면 그 위치로 되돌린다.
 *
 * 복원 시점이 까다롭다: 카드에 이미지/투표 요약이 뒤늦게 붙으면서 문서 높이가 계속 자라기 때문에
 * 한 번만 scrollTo 하면 어긋난다. 그래서 목표 위치에 도달할 때까지 짧은 창(≤2.5s) 동안 재보정하되,
 * 유저가 직접 스크롤하면 즉시 멈춘다(억지로 끌고 다니지 않는다).
 */
export function useFeedScrollRestore(opts: {
  feedKey: string;
  /** 로드된 페이지 수 ref — setState 지연 없이 항상 최신값(useUnifiedFeed 제공). */
  pageCountRef: { current: number };
  loading: boolean;
  pendingScrollY: number | null;
  consumePendingScroll: () => void;
}) {
  const { feedKey, pageCountRef, loading, pendingScrollY, consumePendingScroll } = opts;

  // 브라우저 기본 스크롤 복원을 끈다. 피드는 복귀 직후 1페이지만 들고 시작해 문서가 짧기 때문에
  // 브라우저가 복원한 위치는 잘리거나 0 이 되고, 그게 우리 복원을 덮어쓴다(실측).
  useEffect(() => {
    if (typeof window === "undefined" || !("scrollRestoration" in window.history)) return;
    const prev = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = prev;
    };
  }, []);

  // 최신 feedKey 를 이벤트 핸들러에서 읽기 위한 ref.
  // 렌더 중 ref 를 쓰면 안 되므로(react-hooks/refs) effect 에서만 갱신한다.
  const keyRef = useRef(feedKey);
  useEffect(() => {
    keyRef.current = feedKey;
  }, [feedKey]);

  // 떠나기 직전 저장. Link 클릭(클라이언트 라우팅)은 pagehide가 안 뜨므로 스크롤할 때마다 갱신해 둔다.
  // pageCount 를 state 가 아니라 ref 로 읽는 이유: setState 는 비동기라 방금 로드된 페이지가
  // 반영되기 전에 저장되면 분량이 적게 복원된다(실측: 카드 31인데 pageCount 2로 저장됨).
  useEffect(() => {
    // ⚠️ scrollY === 0 은 저장하지 않는다.
    // 상세로 이동할 때 브라우저가 먼저 스크롤을 0 으로 되돌린 뒤 이 컴포넌트가 언마운트되므로,
    // 언마운트 시점에 무조건 저장하면 방금 기록한 진짜 위치(예: 7107)를 0 으로 덮어써
    // 복원이 항상 맨 위가 된다(실측: saved scrollY 12972 → 0).
    const persist = () => {
      const y = window.scrollY;
      if (y <= 0) return;
      saveFeedRestore(keyRef.current, pageCountRef.current, y);
    };
    // passive: 스크롤 성능 영향 없음.
    window.addEventListener("scroll", persist, { passive: true });
    window.addEventListener("pagehide", persist);
    return () => {
      persist();
      window.removeEventListener("scroll", persist);
      window.removeEventListener("pagehide", persist);
    };
  }, [pageCountRef]);

  // 복원 1회용 가드. state 로 즉시 소비하면 dep 이 바뀌어 cleanup 이 rAF 를 죽인다(실측으로 확인).
  const restoredRef = useRef(false);

  useEffect(() => {
    if (pendingScrollY === null || loading || restoredRef.current) return;
    restoredRef.current = true;

    let cancelled = false;
    let raf = 0;
    const target = pendingScrollY;
    // 카드 이미지·투표 요약이 늦게 붙어 문서가 계속 자라므로 잠시 동안 재보정한다.
    const deadline = Date.now() + 2500;

    // 유저가 직접 스크롤하면 복원 중단 — 강제로 위치를 끌고 가지 않는다.
    const stop = () => {
      cancelled = true;
    };
    window.addEventListener("wheel", stop, { passive: true, once: true });
    window.addEventListener("touchstart", stop, { passive: true, once: true });
    window.addEventListener("keydown", stop, { once: true });

    const step = () => {
      if (cancelled) return;
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      // 아직 콘텐츠가 덜 자라 목표에 못 미치면 도달 가능한 최대치로 붙여두고 다음 프레임 재시도.
      const want = Math.min(target, maxY);
      if (Math.abs(window.scrollY - want) > 2) window.scrollTo(0, want);
      // ⚠️ 목표에 닿았다고 바로 멈추면 안 된다 — 브라우저/라우터의 자체 스크롤 복원이
      // 한 박자 늦게 0 으로 되돌리는 것을 실측했다. 마감기한까지 계속 재주장한다.
      if (Date.now() < deadline) {
        raf = requestAnimationFrame(step);
        return;
      }
      // 복원이 끝난 뒤에만 소비 — 진행 중에 소비하면 dep 이 바뀌어 cleanup 에 취소된다.
      consumePendingScroll();
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    };
  }, [pendingScrollY, loading, consumePendingScroll]);
}
