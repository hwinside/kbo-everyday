"use client";

import { useState, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { ExternalLink, ChevronLeft, Images } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamBySlug } from "@/lib/constants/teams";
import GlassCard from "@/components/ui/GlassCard";
import { useNewsPhotoFilter } from "@/hooks/useNewsPhotoFilter";
import { setPhotoFilterEnabled } from "@/lib/store/news-pref";
import { isPhotoArticle } from "@/lib/news-relevance";
import NewsCommentButton from "@/components/news/NewsCommentButton";
import ContentViewBadge from "@/components/admin/ContentViewBadge";
import { useContentViewCounts } from "@/hooks/useContentViewCounts";
import { newsContentId, type ContentViewType } from "@/lib/content-views/policy";
import { useNewsArticleBrowser } from "@/hooks/useNewsArticleBrowser";

interface NewsItem {
  title: string;
  description: string;
  link: string;
  originalLink?: string;
  pubDate: string;
  thumbnailUrl?: string | null;
}

export default function TeamNewsPage() {
  const { handleArticleAnchorClick } = useNewsArticleBrowser();
  const params = useParams();
  const router = useRouter();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const photoFilterOn = useNewsPhotoFilter();
  const visibleNews = photoFilterOn
    ? news.filter((item) => !isPhotoArticle(item.title))
    : news;

  // 관리자 전용 조회수 — 관리자가 아니면 hook이 요청 자체를 안 한다(최대 40건 상한).
  const viewCountItems = useMemo(() => {
    return visibleNews.slice(0, 40).flatMap((item) => {
      const id = newsContentId(item.link, item.originalLink);
      return id ? [{ type: "news" as ContentViewType, id }] : [];
    });
  }, [visibleNews]);
  const viewCounts = useContentViewCounts(viewCountItems);
  const viewCountOf = (link: string, originalLink?: string): number | undefined => {
    const id = newsContentId(link, originalLink);
    return id ? viewCounts[`news:${id}`] : undefined;
  };

  useEffect(() => {
    if (!team) return;
    fetch(`/api/news?team=${encodeURIComponent(team.shortName)}`)
      .then((r) => r.json())
      .then((d) => {
        const seen = new Set<string>();
        const unique = (d.items || []).filter((item: NewsItem) => {
          if (seen.has(item.link)) return false;
          seen.add(item.link);
          return true;
        });
        setNews(unique);
      })
      .catch(() => setNews([]))
      .finally(() => setLoading(false));
  }, [team]);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "env(safe-area-inset-top, 0px)", marginTop: "calc(env(safe-area-inset-top, 0px) * -1)" }}>
      <header className="flex items-center gap-2 px-5 min-h-[44px]">
        <button onClick={() => { if (window.history.length > 1) router.back(); else router.push(`/teams/${teamSlug}`); }} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="truncate text-lg font-bold text-text-primary flex-1">
          {team.shortName} 뉴스
        </h1>
        <HeaderProfileLink />
      </header>
      </div>

      <div className="px-5">
        {/* 사진기사 숨김 토글 — 헤더에서 바디로 이동. 마이페이지 '뉴스 설정'과 동일 상태 공유 */}
        <div className="flex justify-end pt-3">
          <button
            onClick={() => setPhotoFilterEnabled(!photoFilterOn)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              photoFilterOn ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
            }`}
            aria-pressed={photoFilterOn}
            aria-label={`사진기사 ${photoFilterOn ? "표시" : "숨기기"}`}
          >
            <Images size={14} />
            사진기사 {photoFilterOn ? "숨김" : "표시"}
          </button>
        </div>
        {loading ? (
          <div className="py-20 text-center text-sm text-text-tertiary">
            로딩 중...
          </div>
        ) : visibleNews.length === 0 ? (
          <div className="py-20 text-center text-sm text-text-tertiary">
            관련 기사가 없습니다
          </div>
        ) : (
          <div className="space-y-3">
            {visibleNews.map((item, i) => {
              // 출처 표기는 언론사 원문(originalLink) host 기준 — 클릭만 네이버
              const source = (item.originalLink || item.link).match(/\/\/(?:www\.)?([^/]+)/)?.[1]?.replace(/\.com$|\.co\.kr$|\.kr$/, "") ?? "";
              const article = {
                url: item.link,
                canonicalUrl: item.originalLink || item.link,
                title: item.title.replace(/<[^>]+>/g, ""),
                source,
                thumbnailUrl: item.thumbnailUrl,
                teamId: team.id,
              };
              return (
                <GlassCard key={i} pressable className="overflow-hidden p-0">
                  <a href={item.link} target="_blank" rel="noopener noreferrer" onClick={(event) => handleArticleAnchorClick(event, article)}>
                    {item.thumbnailUrl && (
                      <div className="relative aspect-[16/9] w-full overflow-hidden bg-bg-tertiary">
                        {/* eslint-disable-next-line @next/next/no-img-element -- article OG images come from arbitrary news domains */}
                        <img
                          src={item.thumbnailUrl}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            e.currentTarget.closest("div")?.classList.add("hidden");
                          }}
                        />
                      </div>
                    )}
                    <div className="p-4">
                      <p className="text-sm font-bold text-text-primary line-clamp-2 leading-snug">
                        {item.title.replace(/<[^>]+>/g, "")}
                      </p>
                      <p className="text-xs text-text-secondary mt-2 line-clamp-2 leading-relaxed">
                        {item.description.replace(/<[^>]+>/g, "")}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-[11px] text-text-tertiary">{source}</span>
                        <span className="text-[11px] text-text-tertiary">·</span>
                        <span className="text-[11px] text-text-tertiary">
                          {new Date(item.pubDate).toLocaleDateString("ko-KR")}
                        </span>
                        <ContentViewBadge count={viewCountOf(item.link, item.originalLink)} />
                        <ExternalLink size={13} className="ml-auto text-text-tertiary" />
                      </div>
                    </div>
                  </a>
                  <div className="flex justify-end border-t border-border px-3 py-2">
                    <NewsCommentButton
                      article={article}
                      className="bg-bg-tertiary text-text-secondary hover:bg-bg-primary"
                    />
                  </div>
                </GlassCard>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
