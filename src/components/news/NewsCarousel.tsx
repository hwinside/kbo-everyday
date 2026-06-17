"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import type { NewsMock } from "@/lib/constants/news";

interface NewsCarouselProps {
  news: NewsMock[];
}

const AUTO_INTERVAL = 4000;

export default function NewsCarousel({ news }: NewsCarouselProps) {
  const [current, setCurrent] = useState(0);
  const [isUserPaused, setIsUserPaused] = useState(false);
  // 썸네일 로드 실패 id 집합 — 실패하면 썸네일 없이 현행 레이아웃으로 폴백.
  const [failedThumbs, setFailedThumbs] = useState<Set<NewsMock["id"]>>(new Set());
  // 기사 og:image를 클라이언트에서 점진 로드 — 뉴스 텍스트는 즉시 뜨고 사진은
  // 뒤따라 채워져 홈 로딩이 og 추출에 막히지 않게 한다(서버 블로킹 회피).
  const [ogThumbs, setOgThumbs] = useState<Record<NewsMock["id"], string | null>>({});
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const slides = news.slice(0, 10);
  const len = slides.length;

  // 슬라이드별 og:image를 캐시된 /api/og-meta로 비동기 조회(텍스트 렌더 비차단).
  useEffect(() => {
    let cancelled = false;
    slides.forEach((item) => {
      if (item.thumbnailUrl || ogThumbs[item.id] !== undefined) return;
      if (!item.sourceUrl || item.sourceUrl === "#") return;
      fetch(`/api/og-meta?url=${encodeURIComponent(item.sourceUrl)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled) setOgThumbs((prev) => ({ ...prev, [item.id]: d?.image ?? null }));
        })
        .catch(() => {
          if (!cancelled) setOgThumbs((prev) => ({ ...prev, [item.id]: null }));
        });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [news]);

  // len 변경 시 current clamp
  useEffect(() => {
    setCurrent((prev) => (len === 0 ? 0 : Math.min(prev, len - 1)));
  }, [len]);

  // --- autoplay ---
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startAutoTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setInterval(() => {
      setCurrent((p) => (p + 1) % len);
    }, AUTO_INTERVAL);
  }, [len, clearTimer]);

  useEffect(() => {
    if (isUserPaused || len <= 1) {
      clearTimer();
      return;
    }
    startAutoTimer();
    return clearTimer;
  }, [isUserPaused, len, startAutoTimer, clearTimer]);

  // --- navigation ---
  const goTo = useCallback(
    (idx: number) => {
      if (len === 0) return;
      setCurrent(((idx % len) + len) % len);
      setIsUserPaused(true); // 유저 조작 → 자동재생 정지
    },
    [len],
  );

  // swipe
  const touchStartX = useRef(0);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const dx = e.changedTouches[0].clientX - touchStartX.current;
      if (Math.abs(dx) > 40) {
        goTo(current + (dx < 0 ? 1 : -1));
      }
    },
    [current, goTo],
  );

  return (
    <div
      className="relative select-none"
      role="region"
      aria-roledescription="carousel"
      aria-label="주요 뉴스"
    >
      {/* slides */}
      <div className="overflow-hidden">
        <div
          className="flex transition-transform duration-300 ease-out will-change-transform"
          style={{ transform: `translateX(-${current * 100}%)` }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {slides.map((item, i) => {
            const team = item.teamId ? getTeamById(item.teamId) : null;
            const bg = team
              ? `linear-gradient(135deg, color-mix(in srgb, ${getTeamBgColor(team)} 35%, #1a1a1d) 0%, #1a1a1d 100%)`
              : "linear-gradient(135deg, #2a2a3d 0%, #1a1a1d 100%)";
            // 썸네일이 있고 로드 실패하지 않았으면 왼쪽 사진 + 제목 우측. 없으면 현행 그대로.
            const thumbUrl = item.thumbnailUrl ?? ogThumbs[item.id] ?? null;
            const hasThumb = Boolean(thumbUrl) && !failedThumbs.has(item.id);

            return (
              <div
                key={item.id}
                className="w-full flex-shrink-0 cursor-pointer"
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} / ${len}`}
                onClick={() =>
                  item.sourceUrl && window.open(item.sourceUrl, "_blank")
                }
              >
                <div
                  className="relative h-[172px] w-full overflow-hidden"
                  style={{ background: bg }}
                >
                  {team && (
                    <div className="absolute right-4 top-4 opacity-20">
                      <Image
                        src={team.logoPath}
                        alt=""
                        width={80}
                        height={80}
                        unoptimized
                        className="object-contain"
                      />
                    </div>
                  )}
                  {hasThumb && (
                    <div className="absolute left-[14px] top-4 bottom-4 w-[31%] overflow-hidden rounded-xl shadow-[0_2px_10px_rgba(0,0,0,0.35)]">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={thumbUrl as string}
                        alt=""
                        referrerPolicy="no-referrer"
                        onError={() =>
                          setFailedThumbs((prev) => new Set(prev).add(item.id))
                        }
                        className="h-full w-full object-cover"
                      />
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#1a1a1d] to-transparent" />
                  <div className={`absolute inset-x-0 bottom-0 pb-10 pr-4 ${hasThumb ? "pl-[47%]" : "px-4"}`}>
                    {item.label && (
                      <span className="inline-block px-2 py-0.5 mb-1 rounded-full bg-accent/80 text-xs font-semibold text-white">
                        {item.label}
                      </span>
                    )}
                    <h3 className="text-lg font-semibold leading-[26px] text-white line-clamp-3">
                      {item.title}
                    </h3>
                    <p className="mt-1 text-xs leading-[18px] text-gray-400">
                      {item.source} · {item.timeAgo}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 하단 컨트롤: 좌버튼 + 인디케이터 + 우버튼 */}
      <div className="absolute bottom-2 inset-x-0 z-10 flex items-center justify-center gap-3 px-3">
        {len > 1 && (
          <button
            type="button"
            onClick={() => goTo(current - 1)}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-white/25 text-white backdrop-blur-sm transition-opacity hover:bg-white/40"
            aria-label="이전 뉴스"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
        )}
        <div className="flex gap-1.5">
          {slides.map((_, i) => (
            <button
              type="button"
              key={i}
              onClick={() => goTo(i)}
              aria-label={`뉴스 ${i + 1}번으로 이동`}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === current ? "w-5 bg-accent" : "w-1.5 bg-text-tertiary/40"
              }`}
            />
          ))}
        </div>
        {len > 1 && (
          <button
            type="button"
            onClick={() => goTo(current + 1)}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-white/25 text-white backdrop-blur-sm transition-opacity hover:bg-white/40"
            aria-label="다음 뉴스"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        )}
      </div>
    </div>
  );
}
