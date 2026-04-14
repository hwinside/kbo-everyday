"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import type { NewsMock } from "@/lib/constants/news";

interface NewsCarouselProps {
  news: NewsMock[];
}

// 팀 컬러 기반 그라데이션 배경
function getNewsBg(teamId: number | null) {
  if (!teamId) return "from-accent/30 to-accent/10";
  const team = getTeamById(teamId);
  if (!team) return "from-accent/30 to-accent/10";
  return ""; // 인라인 스타일로 처리
}

export default function NewsCarousel({ news }: NewsCarouselProps) {
  const AUTO_INTERVAL = 4000; // 4초 간격 자동 전환

  const [current, setCurrent] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const restartTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isAutoScrolling = useRef(false);
  const isPaused = useRef(false);

  const slides = news.slice(0, 10);

  // 자동 전환 타이머 시작/재시작
  function startAutoTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    isPaused.current = false;
    timerRef.current = setInterval(() => {
      if (isPaused.current) return;
      isAutoScrolling.current = true;
      setCurrent((prev) => (prev + 1) % slides.length);
    }, AUTO_INTERVAL);
  }

  // 타이머 정지
  function stopAutoTimer() {
    isPaused.current = true;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // pending restart도 정리
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
  }

  // 마운트 시 자동 전환 시작
  useEffect(() => {
    startAutoTimer();
    return () => {
      stopAutoTimer();
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = null;
      }
    };
  }, [slides.length]);

  // 슬라이드 이동
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ left: current * el.offsetWidth, behavior: "smooth" });
    // 자동 스크롤 플래그 해제
    const timeout = setTimeout(() => { isAutoScrolling.current = false; }, 500);
    return () => clearTimeout(timeout);
  }, [current]);

  // 터치/포인터 시 즉시 정지, 놓으면 재시작
  function handleInteractionStart() {
    stopAutoTimer();
  }
  function handleInteractionEnd() {
    // 이전 pending restart 정리 후 새로 예약
    if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
    restartTimeoutRef.current = setTimeout(() => {
      restartTimeoutRef.current = null;
      startAutoTimer();
    }, AUTO_INTERVAL);
  }

  // 수동 스크롤 시 현재 인덱스 업데이트 (자동 스크롤 중에는 무시)
  function handleScroll() {
    if (isAutoScrolling.current) return;
    const el = containerRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / el.offsetWidth);
    if (idx !== current) {
      setCurrent(idx);
    }
  }

  return (
    <div className="relative">
      {/* 슬라이드 컨테이너 */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onTouchStart={handleInteractionStart}
        onTouchEnd={handleInteractionEnd}
        onMouseDown={handleInteractionStart}
        onMouseUp={handleInteractionEnd}
        onMouseLeave={handleInteractionEnd}
        onPointerLeave={handleInteractionEnd}
        className="flex snap-x snap-mandatory overflow-x-auto hide-scrollbar"
      >
        {slides.map((item, i) => {
          const team = item.teamId ? getTeamById(item.teamId) : null;
          return (
            <div
              key={item.id}
              className="w-full flex-shrink-0 snap-start cursor-pointer"
              onClick={() => item.sourceUrl && window.open(item.sourceUrl, "_blank")}
            >
              <div
                className="relative h-[172px] w-full overflow-hidden"
                style={{
                  "--news-bg-light": team
                    ? `linear-gradient(135deg, color-mix(in srgb, ${getTeamBgColor(team)} 35%, #1a1a1d) 0%, #1a1a1d 100%)`
                    : "linear-gradient(135deg, #2a2a3d 0%, #1a1a1d 100%)",
                  "--news-bg-dark": team
                    ? `linear-gradient(135deg, color-mix(in srgb, ${getTeamBgColor(team)} 35%, #1a1a1d) 0%, #1a1a1d 100%)`
                    : "linear-gradient(135deg, #2a2a3d 0%, #1a1a1d 100%)",
                  background: "var(--news-bg-light)",
                } as React.CSSProperties}
              >
                {/* 팀 로고 워터마크 */}
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

                {/* 하단 그라데이션 */}
                <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#1a1a1d] to-transparent" />

                {/* 콘텐츠 */}
                <div className="absolute inset-x-0 bottom-0 px-4 pb-4">
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

      {/* 인디케이터 */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
        {slides.map((_, i) => (
          <button
            key={i}
            onClick={() => setCurrent(i)}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              i === current ? "w-5 bg-accent" : "w-1.5 bg-text-tertiary/40"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
