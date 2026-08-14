"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import NewsCard from "./NewsCard";
import { useContentViewCounts } from "@/hooks/useContentViewCounts";
import { newsContentId, type ContentViewType } from "@/lib/content-views/policy";
import VideoCard from "./VideoCard";
import { TEAMS } from "@/lib/constants/teams";
import type { NewsMock, VideoMock } from "@/lib/constants/news";

type TabType = "all" | "news" | "video";

interface NewsFeedProps {
  news: NewsMock[];
  videos: VideoMock[];
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25 } },
};

export default function NewsFeed({ news, videos }: NewsFeedProps) {
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);

  const tabs: { key: TabType; label: string }[] = [
    { key: "all", label: "전체" },
    { key: "news", label: "뉴스" },
    { key: "video", label: "영상" },
  ];

  const filteredNews = selectedTeam
    ? news.filter((n) => n.teamId === selectedTeam)
    : news;

  const filteredVideos = selectedTeam
    ? videos.filter((v) => v.teamId === selectedTeam)
    : videos;

  // 관리자 전용 조회수 배치 로드 — 관리자가 아니면 요청 자체를 안 한다(최대 40건 상한).
  const viewCountItems = useMemo(() => {
    return filteredNews.slice(0, 40).flatMap((n) => {
      const id = newsContentId(n.sourceUrl, n.ogUrl);
      return id ? [{ type: "news" as ContentViewType, id }] : [];
    });
  }, [filteredNews]);
  const viewCounts = useContentViewCounts(viewCountItems);

  const newsViewCount = (n: (typeof filteredNews)[number]): number | undefined => {
    const id = newsContentId(n.sourceUrl, n.ogUrl);
    return id ? viewCounts[`news:${id}`] : undefined;
  };

  return (
    <div>
      {/* Tabs */}
      <div className="mb-4 flex gap-3">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-full px-5 py-2 text-base font-semibold transition-all ${
              activeTab === tab.key
                ? "bg-accent text-white"
                : "bg-bg-tertiary text-text-secondary hover:text-text-primary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Team filter chips */}
      <div className="mb-5 flex gap-4 overflow-x-auto hide-scrollbar -mx-4 px-4">
        <button
          onClick={() => setSelectedTeam(null)}
          className={`flex-shrink-0 rounded-full px-4 py-1 text-base font-medium transition-all ${
            selectedTeam === null
              ? "bg-text-primary text-bg-primary"
              : "bg-bg-tertiary text-text-secondary"
          }`}
        >
          전체
        </button>
        {TEAMS.map((team) => (
          <button
            key={team.id}
            onClick={() => setSelectedTeam(team.id === selectedTeam ? null : team.id)}
            className="flex-shrink-0 rounded-full px-4 py-1 text-base font-semibold text-white transition-all"
            style={{
              backgroundColor:
                selectedTeam === team.id
                  ? team.colorPrimary
                  : "var(--bg-tertiary)",
              color:
                selectedTeam === team.id ? "white" : "var(--text-secondary)",
            }}
          >
            {team.shortName}
          </button>
        ))}
      </div>

      {/* Feed */}
      <AnimatePresence mode="wait">
        <motion.div
          key={`${activeTab}-${selectedTeam}`}
          variants={container}
          initial="hidden"
          animate="show"
          className="space-y-4"
        >
          {(activeTab === "all" || activeTab === "news") &&
            filteredNews.map((n) => (
              <motion.div key={`news-${n.id}`} variants={item}>
                <NewsCard news={n} viewCount={newsViewCount(n)} />
              </motion.div>
            ))}

          {(activeTab === "all" || activeTab === "video") &&
            filteredVideos.map((v) => (
              <motion.div key={`video-${v.id}`} variants={item}>
                <VideoCard video={v} />
              </motion.div>
            ))}

          {/* Empty state */}
          {((activeTab === "news" && filteredNews.length === 0) ||
            (activeTab === "video" && filteredVideos.length === 0) ||
            (activeTab === "all" &&
              filteredNews.length === 0 &&
              filteredVideos.length === 0)) && (
            <div className="py-12 text-center text-text-tertiary">
              <p className="text-3xl">📭</p>
              <p className="mt-2 text-base">아직 소식이 없습니다</p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
