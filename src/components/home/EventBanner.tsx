"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { X } from "lucide-react";

/**
 * 얼리멤버 이벤트 배너 (2026-04-20 ~ 2026-05-31)
 *
 * 홈/커뮤니티 상단 노출. 클릭 → /events/invite 랜딩.
 * 우상단 X 클릭 시 7일간 localStorage 기반 dismiss.
 *
 * 배너 에셋: /public/event-banner-home.jpg (718x154, v5-final에서 크롭)
 * 배너 교체 시 같은 경로로 덮어쓰면 됨. 디자이너 원본 오면 무중단 업데이트 가능.
 */

const DISMISS_KEY = "event_banner_invite_dismissed_at";
const DISMISS_DAYS = 7;
const EVENT_END = new Date("2026-06-01T00:00:00+09:00"); // 이벤트 종료 시점 (KST 5/31 24:00)

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

const BANNER_ID = "invite_airpods";

type Props = {
  /** 광고 위치 구분 (GA4 click_source) */
  source?: "home" | "community";
};

export default function EventBanner({ source = "home" }: Props) {
  const [visible, setVisible] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const impressionFiredRef = useRef(false);

  // 세션당 source별 1회만 impression 발화 (sessionStorage)
  const impressionSessionKey = `event_banner_imp_${BANNER_ID}_${source}`;

  useEffect(() => {
    // 이벤트 종료 후 자동 비노출
    if (Date.now() >= EVENT_END.getTime()) {
      setVisible(false);
      return;
    }
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (raw) {
        const dismissedAt = parseInt(raw, 10);
        const daysPassed = (Date.now() - dismissedAt) / (1000 * 60 * 60 * 24);
        if (daysPassed < DISMISS_DAYS) {
          setVisible(false);
          return;
        }
      }
    } catch {
      // localStorage 불가 환경(프라이빗 브라우저 등) — 그냥 노출
    }
    setVisible(true);
  }, []);

  // Impression tracker: 50% 브표트 + 1쌀 체류 시 1회 발화 (세션당 source별 1회)
  useEffect(() => {
    if (!visible) return;
    const el = linkRef.current;
    if (!el) return;

    // 이미 세션 내 발화했으면 skip
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
            // 1쌀 체류 게이팅
            if (!dwellTimer && !impressionFiredRef.current) {
              dwellTimer = setTimeout(() => {
                if (impressionFiredRef.current) return;
                impressionFiredRef.current = true;
                trackEvent("event_banner_impression", {
                  banner: BANNER_ID,
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
  }, [visible, source, impressionSessionKey]);

  const handleDismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // noop
    }
    trackEvent("event_banner_dismiss", {
      banner: BANNER_ID,
      source,
      slot: "top",
    });
    setVisible(false);
  };

  const handleClick = () => {
    trackEvent("event_banner_click", {
      banner: BANNER_ID,
      source,
      slot: "top",
    });
  };

  if (!visible) return null;

  return (
    <div className="mb-4">
      <Link
        ref={linkRef}
        href="/events/invite"
        onClick={handleClick}
        className="block relative rounded-2xl overflow-hidden border border-white/10 shadow-lg active:scale-[0.99] transition-transform"
        aria-label="얼리멤버 이벤트 — 친구 초대하고 글 쓰면 에어팟 프로 3까지"
      >
        <Image
          src="/event-banner-home.jpg"
          alt="친구 초대하고 글 쓰면 에어팟 프로 3까지 · 5월 31일까지"
          width={718}
          height={154}
          sizes="(max-width: 640px) 100vw, 640px"
          priority
          className="w-full h-auto block"
        />
        <button
          type="button"
          onClick={handleDismiss}
          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/40 hover:bg-black/60 flex items-center justify-center backdrop-blur-sm"
          aria-label="배너 닫기"
        >
          <X size={14} className="text-white/90" />
        </button>
      </Link>
    </div>
  );
}
