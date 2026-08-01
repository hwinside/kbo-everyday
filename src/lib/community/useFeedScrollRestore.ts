"use client";

import { useEffect, useRef } from "react";
import { clearFeedRestore, decideFeedPersist, saveFeedRestore } from "@/lib/community/feed-restore";

/**
 * 피드 페이지에 붙이는 스크롤 복원 훅.
 *
 *  - 페이지를 떠나기 직전(링크 클릭/pagehide/언마운트) 현재 스크롤 + 로드 페이지 수를 저장한다.
 *  - `useUnifiedFeed`가 복원 페이지를 다 채우고 `pendingScrollY`를 넘겨주면 그 위치로 되돌린다.
 *
 * 복원 시점이 까다롭다: 카드에 이미지/투표 요약이 뒤늦게 붙으면서 문서 높이가 계속 자라기 때문에
 * 한 번만 scrollTo 하면 어긋난다. 그래서 목표 위치에 도달할 때까지 짧은 창(≤2.5s) 동안 재보정하되,
 * 유저가 직접 스크롤하면 즉시 멈춘다(억지로 끌고 다니지 않는다).
 */
export function useFeedScrollRestore(opts: {
  feedKey: string;
  /** 이 피드의 라우트 경로. "떠나는 중인가" 판정에 쓴다. */
  feedPath: string;
  /** 로드된 페이지 수 ref — setState 지연 없이 항상 최신값(useUnifiedFeed 제공). */
  pageCountRef: { current: number };
  loading: boolean;
  pendingScrollY: number | null;
  consumePendingScroll: () => void;
}) {
  const { feedKey, feedPath, pageCountRef, loading, pendingScrollY, consumePendingScroll } = opts;

  // 최신 feedKey/feedPath 를 이벤트 핸들러에서 읽기 위한 ref.
  // 렌더 중 ref 를 쓰면 안 되므로(react-hooks/refs) effect 에서만 갱신한다.
  const keyRef = useRef(feedKey);
  const pathRef = useRef(feedPath);
  useEffect(() => {
    keyRef.current = feedKey;
    pathRef.current = feedPath;
  }, [feedKey, feedPath]);

  // 떠나기 직전 저장. Link 클릭(클라이언트 라우팅)은 pagehide가 안 뜨므로 스크롤할 때마다 갱신해 둔다.
  // pageCount 를 state 가 아니라 ref 로 읽는 이유: setState 는 비동기라 방금 로드된 페이지가
  // 반영되기 전에 저장되면 분량이 적게 복원된다(실측: 카드 31인데 pageCount 2로 저장됨).
  //
  // 0 을 다루는 방식이 핵심이다.
  //  - 상세로 이동할 때 라우터/브라우저가 먼저 스크롤을 0 으로 되돌린 뒤 피드가 언마운트되므로,
  //    그 0 을 저장하면 진짜 위치가 지워진다(실측 12972 → 0 → 복원해도 맨 위).
  //  - 그렇다고 "y<=0 이면 무조건 무시"로 두면 **유저가 직접 맨 위로 올린 진짜 0** 까지 무시돼
  //    다음 복귀에 오래된 깊은 위치로 튄다(삼순 리뷰 실측: 12972 → top → 진입 → back → 12972).
  // 그래서 둘을 "링크를 클릭해 떠나는 중인가"로 구분한다:
  //  - 링크 클릭(capture) 순간의 y/pageCount 를 확정 저장하고, 그 뒤 라우터가 만든 0 은 무시
  //  - 떠나는 중이 아니면 스크롤을 그대로 반영하고, 진짜 0(최상단)은 저장 상태를 제거
  useEffect(() => {
    let leaving = false;

    // 판정은 순수 함수(decideFeedPersist)에 위임한다 — 회귀가 그 함수를 직접 검증한다.
    const apply = (isLeaving: boolean, y: number) => {
      const decision = decideFeedPersist(isLeaving, y);
      if (decision === "ignore") return;
      // 유저가 직접 만든 최상단 — 복원할 게 없으므로 오래된 깊은 위치를 반드시 지운다.
      if (decision === "clear") {
        clearFeedRestore(keyRef.current);
        return;
      }
      saveFeedRestore(keyRef.current, pageCountRef.current, y);
    };

    const onScroll = () => {
      apply(leaving, window.scrollY);
    };

    // 유저가 여전히 이 화면을 조작 중 — 클릭했지만 네비게이션이 안 일어난 경우 복귀.
    const onUserInput = () => {
      leaving = false;
    };

    // capture 단계에서 링크 클릭을 잡아 떠나기 직전의 진짜 위치를 확정 저장한다.
    const onClickCapture = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      let dest: URL;
      try {
        dest = new URL(href, window.location.origin);
      } catch {
        return;
      }
      // 같은 피드 안에서의 이동은 이탈이 아니다.
      if (dest.origin === window.location.origin && dest.pathname === pathRef.current) return;
      // 클릭 순간의 위치가 확정 저장 대상이다(아직 떠나지 않은 상태로 판정 → save/clear).
      apply(false, window.scrollY);
      leaving = true;
    };

    // passive: 스크롤 성능 영향 없음.
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onUserInput, { passive: true });
    window.addEventListener("touchstart", onUserInput, { passive: true });
    window.addEventListener("pagehide", onScroll);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      onScroll();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onUserInput);
      window.removeEventListener("touchstart", onUserInput);
      window.removeEventListener("pagehide", onScroll);
      document.removeEventListener("click", onClickCapture, true);
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
      // 목표에 닿았다고 바로 멈추면 안 된다 — 브라우저/라우터의 자체 스크롤 복원이
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
