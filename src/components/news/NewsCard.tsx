"use client";

import { motion } from "framer-motion";
import { ExternalLink } from "lucide-react";
import TeamBadge from "@/components/ui/TeamBadge";
import type { NewsMock } from "@/lib/constants/news";
import NewsCommentButton from "@/components/news/NewsCommentButton";
import ContentViewBadge from "@/components/admin/ContentViewBadge";
import { useNewsArticleBrowser } from "@/hooks/useNewsArticleBrowser";

interface NewsCardProps {
  news: NewsMock;
  /** 관리자 전용 조회수 — 상위(NewsFeed 등)에서 배치 로드해 주입. 미제공 시 미표시. */
  viewCount?: number;
}

export default function NewsCard({ news, viewCount }: NewsCardProps) {
  const { handleArticleAnchorClick } = useNewsArticleBrowser();
  const article = {
    url: news.sourceUrl,
    canonicalUrl: news.ogUrl || news.sourceUrl,
    title: news.title,
    source: news.source,
    thumbnailUrl: news.thumbnailUrl,
    teamId: news.teamId,
  };

  return (
    <motion.div
      className="glass-card relative transition-colors hover:bg-white/[0.03]"
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      <a
        href={news.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => handleArticleAnchorClick(event, article)}
        className="flex gap-4 p-5 pr-20"
      >
        {/* Thumbnail placeholder */}
        <div className="relative h-20 w-20 flex-shrink-0 overflow-hidden rounded-lg bg-bg-tertiary">
          <div className="flex h-full w-full items-center justify-center text-2xl text-text-tertiary">
            📰
          </div>
        </div>

        <div className="flex flex-1 flex-col justify-between min-w-0">
          <p className="text-base font-medium leading-snug text-text-primary line-clamp-2">
            {news.title}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            {news.teamId && <TeamBadge teamId={news.teamId} />}
            <span className="text-base text-text-tertiary">
              {news.source}
            </span>
            <span className="text-base text-text-tertiary">·</span>
            <span className="text-base text-text-tertiary">
              {news.timeAgo}
            </span>
            <ContentViewBadge count={viewCount} />
            <ExternalLink size={20} className="ml-auto text-text-tertiary" />
          </div>
        </div>
      </a>
      <NewsCommentButton
        article={article}
        className="absolute bottom-4 right-4 bg-bg-tertiary text-text-secondary hover:bg-bg-secondary"
      />
    </motion.div>
  );
}
