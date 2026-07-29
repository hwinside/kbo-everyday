"use client";

import { useEffect, useRef } from "react";
import { hasTrackedVenueStoryView, trackVenueStoryView } from "./view-tracker-client";

/**
 * 직관 스토리 트레이 임프레션 트래킹 훅 — #735 usePostImpression 의 50%+0.5s 패턴 재사용.
 *
 * 반환된 ref 를 트레이 타일(센서 엘리먼트)에 걸면, 세로 ≥50% 가 뷰포트에 들어오고
 * 0.5초 이상 머무를 때 impression 1회 집계(탭 세션·KST 일자당 스토리 1회 — view-tracker-client).
 * 빠른 스크롤(0.5초 미만)은 미집계. 서버는 스토리×뷰어×kind×KST일 dedupe 를 별도 보장.
 *
 * #735 과 달리 viewer 식별은 전송 시점에 세션/직관 스토리 guest UUID로 해석하므로
 * auth 복원 대기 가드가 필요 없다(관찰 시점 user 스냅샷을 키로 쓰지 않음).
 */
export function useVenueStoryImpression<T extends HTMLElement = HTMLSpanElement>(
  storyId: number,
  disabled = false,
) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;
    if (!Number.isInteger(storyId) || storyId <= 0) return;
    if (hasTrackedVenueStoryView(storyId, "impression")) return;
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
            if (hasTrackedVenueStoryView(storyId, "impression")) return;
            void trackVenueStoryView(storyId, "impression");
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
  }, [storyId, disabled]);

  return ref;
}
