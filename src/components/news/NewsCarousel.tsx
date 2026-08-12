"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { readableTextColor } from "@/lib/utils/team";
import type { NewsMock } from "@/lib/constants/news";
import NewsCommentButton from "@/components/news/NewsCommentButton";
import { useNewsArticleBrowser } from "@/hooks/useNewsArticleBrowser";
import { useAuth } from "@/lib/supabase/AuthContext";

interface NewsCarouselProps {
  news: NewsMock[];
}

const AUTO_INTERVAL = 4000;

export default function NewsCarousel({ news }: NewsCarouselProps) {
  const { user } = useAuth();
  const { openArticle } = useNewsArticleBrowser();
  const [current, setCurrent] = useState(0);
  const [isUserPaused, setIsUserPaused] = useState(false);
  // 썸네일 로드 실패 id 집합 — 실패하면 썸네일 없이 현행 레이아웃으로 폴백.
  const [failedThumbs, setFailedThumbs] = useState<Set<NewsMock["id"]>>(new Set());
  // 기사 og:image를 클라이언트에서 점진 로드 — 뉴스 텍스트는 즉시 뜨고 사진은
  // 뒤따라 채워져 홈 로딩이 og 추출에 막히지 않게 한다(서버 블로킹 회피).
  const [ogThumbs, setOgThumbs] = useState<Record<string, string | null>>({});
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const slides = news.slice(0, 10);
  const len = slides.length;

  // 홈 카드 댓글 수는 최대 10건을 한 번에 조회한다. 조회만으로 빈 댓글방을 만들지 않는다.
  // 댓글은 로그인 유저 공개(admin-only 해제 = 전체 로그인 유저)라 미로그인은 count 조회 불필요.
  useEffect(() => {
    if (!user) return;
    const articles = news.slice(0, 10)
      .filter((item) => item.sourceUrl && item.sourceUrl !== "#")
      .map((item) => ({
        lookupId: String(item.id),
        url: item.sourceUrl,
        canonicalUrl: item.ogUrl || item.sourceUrl,
      }));
    if (articles.length === 0) return;

    let cancelled = false;
    // GET + 정렬된 쿼리 → 전 유저가 같은 top-10을 조회하므로 엣지캐시(60초) HIT가 흥수.
    // 응답은 canonical url로 키잉 → lookupId로 재매핑.
    const query = [...articles]
      .map((a) => a.canonicalUrl)
      .sort()
      .map((u) => `u=${encodeURIComponent(u)}`)
      .join("&");
    fetch(`/api/news/discussion/counts?${query}`)
      .then((response) => response.ok ? response.json() : null)
      .then((result) => {
        if (!cancelled && result?.counts) {
          setCommentCounts(
            Object.fromEntries(
              articles.map((a) => [a.lookupId, Number(result.counts[a.canonicalUrl] ?? 0)]),
            ),
          );
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [news, user]);

  // 최대 10개 og:image를 단일 batch로 비동기 조회(텍스트 렌더 비차단).
  useEffect(() => {
    let cancelled = false;
    const targets = slides.flatMap((item) => {
      if (item.thumbnailUrl) return [];
      // OG 추출은 언론사 원문(ogUrl) 우선 — 클릭 타깃(sourceUrl=네이버)과 분리
      const ogTarget = item.ogUrl || item.sourceUrl;
      if (!ogTarget || ogTarget === "#" || ogThumbs[ogTarget] !== undefined) return [];
      return [ogTarget];
    });
    const urls = Array.from(new Set(targets));
    if (urls.length === 0) return;

    fetch("/api/og-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (cancelled) return;
        const items = result?.items as Record<string, { image?: string | null } | null> | undefined;
        setOgThumbs((prev) => {
          const next: Record<string, string | null> = {};
          for (const item of slides) {
            if (item.thumbnailUrl) continue;
            const url = item.ogUrl || item.sourceUrl;
            if (!url || url === "#") continue;
            next[url] = items?.[url]?.image ?? prev[url] ?? null;
          }
          return next;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setOgThumbs((prev) => {
          const next: Record<string, string | null> = {};
          for (const item of slides) {
            if (item.thumbnailUrl) continue;
            const url = item.ogUrl || item.sourceUrl;
            if (!url || url === "#") continue;
            next[url] = prev[url] ?? null;
          }
          return next;
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
            // 다크: 기존 다크 히어로(흰 글씨) 그대로 유지. 라이트: 옅은 팀틴트 카드 +
            // 진한 글씨 + 팀색은 상단선·라벨·로고 포인트로만(하린아빠 B안, 흰 테마 톤 통일).
            // 두 테마 마크업을 dark:hidden / hidden dark:block으로 분리 → 다크 회귀 0 보장.
            const bgDark = team
              ? `linear-gradient(135deg, color-mix(in srgb, ${getTeamBgColor(team)} 35%, #1a1a1d) 0%, #1a1a1d 100%)`
              : "linear-gradient(135deg, #2a2a3d 0%, #1a1a1d 100%)";
            // 라이트 카드 포인트색: 팀 원색(흰 카드 위 대비 확보). 무팀 뉴스는 앱 accent.
            const accent = team?.colorPrimary ?? "var(--accent)";
            // pill 글자색은 팀색 대비 최대로(밝은 팀색=한화는 흰 글씨 2.94:1이라 어둡게). 삼순 리뷰.
            const pillText = team ? readableTextColor(team.colorPrimary) : "#FFFFFF";
            const bgLightCard = team
              ? `color-mix(in srgb, ${team.colorPrimary} 6%, #FFFFFF)`
              : "#FFFFFF";
            // 썸네일이 있고 로드 실패하지 않았으면 왼쪽 사진 + 제목 우측. 없으면 현행 그대로.
            const ogTarget = item.ogUrl || item.sourceUrl;
            const thumbUrl = item.thumbnailUrl ?? ogThumbs[ogTarget] ?? null;
            const hasThumb = Boolean(thumbUrl) && !failedThumbs.has(item.id);
            const article = {
              url: item.sourceUrl,
              canonicalUrl: item.ogUrl || item.sourceUrl,
              title: item.title,
              source: item.source,
              thumbnailUrl: thumbUrl,
              teamId: item.teamId,
            };

            return (
              <div
                key={item.id}
                className="relative w-full flex-shrink-0"
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} / ${len}`}
              >
                {/* ── 다크: 기존 히어로(팀컬러→#1a1a1d, 흰 글씨) 그대로 ── */}
                <button
                  type="button"
                  aria-label={`${item.title} 원문 보기`}
                  className="relative hidden h-[172px] w-full cursor-pointer overflow-hidden text-left dark:block"
                  style={{ background: bgDark }}
                  onClick={() => openArticle(article)}
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
                    <div className="absolute left-[14px] top-4 bottom-10 w-[31%] overflow-hidden rounded-xl shadow-[0_2px_10px_rgba(0,0,0,0.35)]">
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
                    <h3 className="text-[15px] font-semibold leading-[21px] text-white line-clamp-3">
                      {item.title}
                    </h3>
                    <p className="mt-1 text-xs leading-[18px] text-gray-400">
                      {item.source} · {item.timeAgo}
                    </p>
                  </div>
                </button>

                {/* ── 라이트: 옅은 팀틴트 카드(진한 글씨·팀색 포인트, 인셋+라운드) ── */}
                <div className="px-4 dark:hidden">
                  <button
                    type="button"
                    aria-label={`${item.title} 원문 보기`}
                    className="relative h-[172px] w-full cursor-pointer overflow-hidden rounded-2xl border border-black/[0.06] text-left shadow-sm"
                    style={{ background: bgLightCard, borderTopWidth: 3, borderTopColor: accent }}
                    onClick={() => openArticle(article)}
                  >
                    {team && (
                      <div className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-lg bg-white shadow-sm ring-1 ring-black/[0.04]">
                        <Image
                          src={team.logoPath}
                          alt=""
                          width={20}
                          height={20}
                          unoptimized
                          className="object-contain"
                        />
                      </div>
                    )}
                    {hasThumb && (
                      <div className="absolute left-[14px] top-4 bottom-10 w-[31%] overflow-hidden rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
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
                    <div className={`absolute inset-x-0 bottom-0 pb-9 pr-4 ${hasThumb ? "pl-[47%]" : "px-4"}`}>
                      {item.label && (
                        <span
                          className="inline-block px-2 py-0.5 mb-1 rounded-full text-xs font-semibold"
                          style={{ background: accent, color: pillText }}
                        >
                          {item.label}
                        </span>
                      )}
                      <h3 className="text-[15px] font-semibold leading-[21px] text-text-primary line-clamp-3">
                        {item.title}
                      </h3>
                      <p className="mt-1 text-xs leading-[18px] text-text-tertiary">
                        {item.source} · {item.timeAgo}
                      </p>
                    </div>
                  </button>
                </div>
                <NewsCommentButton
                  article={article}
                  initialCount={commentCounts[String(item.id)] ?? 0}
                  showCount
                  onCountChange={(next) => setCommentCounts((previous) => ({
                    ...previous,
                    [String(item.id)]: next,
                  }))}
                  className="absolute bottom-2 right-5 z-20 bg-black/10 text-neutral-600 hover:bg-black/20 dark:bg-white/25 dark:text-white dark:hover:bg-white/40 backdrop-blur-sm"
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* 하단 컨트롤: 좌버튼 + 인디케이터 + 우버튼 */}
      <div className="pointer-events-none absolute bottom-2 inset-x-0 z-10 flex items-center justify-center gap-3 px-3">
        {len > 1 && (
          <button
            type="button"
            onClick={() => goTo(current - 1)}
            className="pointer-events-auto flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-black/10 text-neutral-600 dark:bg-white/25 dark:text-white backdrop-blur-sm transition-opacity hover:bg-black/20 dark:hover:bg-white/40"
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
              className={`pointer-events-auto h-1.5 rounded-full transition-all duration-300 ${
                i === current ? "w-5 bg-accent" : "w-1.5 bg-text-tertiary/40"
              }`}
            />
          ))}
        </div>
        {len > 1 && (
          <button
            type="button"
            onClick={() => goTo(current + 1)}
            className="pointer-events-auto flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-black/10 text-neutral-600 dark:bg-white/25 dark:text-white backdrop-blur-sm transition-opacity hover:bg-black/20 dark:hover:bg-white/40"
            aria-label="다음 뉴스"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        )}
      </div>
    </div>
  );
}
