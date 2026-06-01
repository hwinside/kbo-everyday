"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { Trophy } from "lucide-react";

/**
 * 얼리멤버 이벤트 배너 (2026-04-20 ~ 2026-05-31)
 *
 * 홈/커뮤니티 상단 노출. 행사 중 클릭 → /events/invite 랜딩.
 * 행사 종료 후 클릭 → 결과 공지(/whats-new).
 *
 * 2026-04-20 하린아빠 지시 — X 닫기 버튼 제거. 이벤트 종료(6/1) 시까지 상시 노출.
 *
 * 배너 에셋: /public/event-banner-home.png (780x120, v20 최종본)
 * 배너 교체 시 같은 경로로 덮어쓰면 됨.
 */

const EVENT_END = new Date("2026-06-01T00:00:00+09:00"); // 이벤트 종료 시점 (KST 5/31 24:00)
const RESULT_ANNOUNCEMENT_PATH = "/whats-new";
const ACTIVE_BANNER_ID = "invite_airpods";
const RESULT_BANNER_ID = "invite_airpods_result";

// GA4 헬퍼 — 타입 가드 + noop fallback
function trackEvent(name: string, params: Record<string, string | number>) {
  try {
    (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag?.(
      "event",
      name,
      params,
    );
  } catch {
    // noop
  }
}

type BannerMode = "active" | "result";

type Props = {
  /** 광고 위치 구분 (GA4 click_source) */
  source?: "home" | "community";
};

export default function EventBanner({ source = "home" }: Props) {
  const [mode] = useState<BannerMode>(() =>
    Date.now() >= EVENT_END.getTime() ? "result" : "active",
  );
  const linkRef = useRef<HTMLAnchorElement>(null);
  const impressionFiredRef = useRef(false);
  const isResultMode = mode === "result";
  const bannerId = isResultMode ? RESULT_BANNER_ID : ACTIVE_BANNER_ID;

  // 세션당 source별 1회만 impression 발화 (sessionStorage)
  const impressionSessionKey = `event_banner_imp_${bannerId}_${source}`;

  // Impression tracker: 50% 뷰포트 + 1초 체류 시 1회 발화 (세션당 source별 1회)
  useEffect(() => {
    const el = linkRef.current;
    if (!el) return;

    try {
      if (sessionStorage.getItem(impressionSessionKey)) {
        impressionFiredRef.current = true;
        return;
      }
    } catch {
      // noop
    }

    let dwellTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (!dwellTimer && !impressionFiredRef.current) {
              dwellTimer = setTimeout(() => {
                if (impressionFiredRef.current) return;
                impressionFiredRef.current = true;
                trackEvent("event_banner_impression", {
                  banner: bannerId,
                  source,
                  slot: "top",
                });
                try {
                  sessionStorage.setItem(impressionSessionKey, "1");
                } catch {
                  // noop
                }
                observer.disconnect();
              }, 1000);
            }
          } else if (dwellTimer) {
            clearTimeout(dwellTimer);
            dwellTimer = null;
          }
        }
      },
      { threshold: [0.5] },
    );

    observer.observe(el);
    return () => {
      if (dwellTimer) clearTimeout(dwellTimer);
      observer.disconnect();
    };
  }, [mode, bannerId, source, impressionSessionKey]);

  const handleClick = () => {
    trackEvent("event_banner_click", {
      banner: bannerId,
      source,
      slot: "top",
    });
  };

  return (
    <div className="mb-4">
      <Link
        ref={linkRef}
        href={isResultMode ? RESULT_ANNOUNCEMENT_PATH : "/events/invite"}
        onClick={handleClick}
        className="block relative rounded-2xl overflow-hidden border border-white/10 shadow-lg active:scale-[0.99] transition-transform"
        aria-label={
          isResultMode
            ? "얼리버드 이벤트 결과 — 결과공지 보기"
            : "얼리멤버 이벤트 — 친구 초대하고 글 쓰면 에어팟 프로 3까지"
        }
      >
        {isResultMode ? (
          <div className="relative min-h-[92px] overflow-hidden bg-gradient-to-r from-[#17181d] via-[#2b1c27] to-[#5c1f1f] px-5 py-4">
            <Trophy
              size={68}
              strokeWidth={1.5}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-amber-200/20"
              aria-hidden="true"
            />
            <div className="relative pr-16">
              <p className="text-[11px] font-medium text-amber-200/85">
                2026년 6월 1일 00:00 기준
              </p>
              <h2 className="mt-1 text-[20px] font-extrabold leading-tight text-white">
                얼리버드 이벤트 결과
              </h2>
              <p className="mt-1 text-xs font-medium text-white/75">
                최종 순위·상품·뱃지를 확인하세요
              </p>
            </div>
          </div>
        ) : (
          <Image
            src="/event-banner-home.png"
            alt="친구 초대하고 글 쓰면 에어팟 프로 3까지 · 5월 31일까지"
            width={780}
            height={120}
            sizes="(max-width: 640px) 100vw, 640px"
            priority
            className="w-full h-auto block"
          />
        )}
      </Link>
    </div>
  );
}
