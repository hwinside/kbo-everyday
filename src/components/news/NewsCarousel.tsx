"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import { getTeamById } from "@/lib/constants/teams";
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
  const [current, setCurrent] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const slides = news.slice(0, 10);

  // 자동 스크롤
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setCurrent((prev) => (prev + 1) % slides.length);
    }, 4000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [slides.length]);

  // 슬라이드 이동
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ left: current * el.offsetWidth, behavior: "smooth" });
  }, [current]);

  // 수동 스크롤 시 현재 인덱스 업데이트
  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / el.offsetWidth);
    if (idx !== current) {
      setCurrent(idx);
      // 수동 스크롤 시 타이머 리셋
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setCurrent((prev) => (prev + 1) % slides.length);
      }, 4000);
    }
  }

  return (
    <div className="relative">
      {/* 슬라이드 컨테이너 */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
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
                className="relative h-[240px] w-full overflow-hidden"
                style={{
                  background: team
                    ? `linear-gradient(135deg, ${team.colorPrimary}40 0%, ${team.colorPrimary}15 50%, #0A0A0B 100%)`
                    : "linear-gradient(135deg, rgba(99,102,241,0.3) 0%, rgba(99,102,241,0.1) 50%, #0A0A0B 100%)",
                }}
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
                <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-bg-primary to-transparent" />

                {/* 콘텐츠 */}
                <div className="absolute inset-x-0 bottom-0 px-4 pb-4">
                  {item.label && (
                    <span className="inline-block px-2 py-0.5 mb-1 rounded-full bg-accent/80 text-xs font-semibold text-white">
                      {item.label}
                    </span>
                  )}
                  <h3 className="text-lg font-bold text-text-primary leading-snug line-clamp-3">
                    {item.title}
                  </h3>
                  <p className="mt-1 text-xs text-text-tertiary">
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
