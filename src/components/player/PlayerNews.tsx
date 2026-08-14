"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { TEAMS } from "@/lib/constants/teams";
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

interface PlayerNewsProps {
  playerName: string;
  teamId?: number;
}

export default function PlayerNews({ playerName, teamId }: PlayerNewsProps) {
  const { handleArticleAnchorClick } = useNewsArticleBrowser();
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);

  // 관리자 전용 조회수 — 관리자가 아니면 hook이 요청 자체를 안 한다(최대 40건 상한).
  const viewCountItems = useMemo(() => {
    return news.slice(0, 40).flatMap((item) => {
      const id = newsContentId(item.link, item.originalLink);
      return id ? [{ type: "news" as ContentViewType, id }] : [];
    });
  }, [news]);
  const viewCounts = useContentViewCounts(viewCountItems);
  const viewCountOf = (link: string, originalLink?: string): number | undefined => {
    const id = newsContentId(link, originalLink);
    return id ? viewCounts[`news:${id}`] : undefined;
  };

  useEffect(() => {
    const teamObj = teamId ? TEAMS.find(t => t.id === teamId) : null;
    const params = new URLSearchParams({
      player: playerName,
      includeThumbnail: "1",
    });
    if (teamObj) params.set("team", teamObj.shortName);

    fetch(`/api/news?${params.toString()}`)
      .then(r => r.json())
      .then(d => {
        // 중복 제거 (link 기준)
        const seen = new Set<string>();
        const unique = (d.items || []).filter((item: NewsItem) => {
          if (seen.has(item.link)) return false;
          seen.add(item.link);
          return true;
        });
        
        setNews(unique.slice(0, 5));
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [playerName, teamId]);

  if (loading) {
    return (
      <div className="mt-6 mb-20">
        <h3 className="text-base font-bold text-text-primary mb-3">관련 기사</h3>
        <div className="text-sm text-text-tertiary">로딩 중...</div>
      </div>
    );
  }

  return (
    <div className="mt-6 mb-20">
      <h3 className="text-base font-bold text-text-primary mb-3">관련 기사</h3>
      {news.length === 0 ? (
        <div className="text-sm text-text-tertiary text-center py-4">
          관련 기사가 없습니다
        </div>
      ) : (
        <div className="space-y-2">
          {news.map((item, i) => {
            const article = {
              url: item.link,
              canonicalUrl: item.originalLink || item.link,
              title: item.title,
              thumbnailUrl: item.thumbnailUrl,
              teamId,
            };
            return (
              <GlassCard key={i} pressable className="overflow-hidden p-0">
                <a href={item.link} target="_blank" rel="noopener noreferrer" onClick={(event) => handleArticleAnchorClick(event, article)}>
                <div className="flex gap-3">
                  {item.thumbnailUrl && (
                    <div className="h-24 w-28 shrink-0 overflow-hidden bg-bg-tertiary">
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
                  <div className={`min-w-0 flex-1 p-3 ${item.thumbnailUrl ? "pl-0" : ""}`}>
                    <p className="text-sm font-medium text-text-primary line-clamp-2">
                      {item.title}
                    </p>
                    <p className="text-xs text-text-tertiary mt-1 line-clamp-1">
                      {item.description}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <p className="text-xs text-text-tertiary">
                        {new Date(item.pubDate).toLocaleDateString("ko-KR")}
                      </p>
                      <ContentViewBadge count={viewCountOf(item.link, item.originalLink)} />
                      <ExternalLink size={14} className="text-text-tertiary" />
                    </div>
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
  );
}
