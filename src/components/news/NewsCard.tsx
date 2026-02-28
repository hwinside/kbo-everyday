"use client";

import { motion } from "framer-motion";
import { ExternalLink } from "lucide-react";
import TeamBadge from "@/components/ui/TeamBadge";
import type { NewsMock } from "@/lib/constants/news";

interface NewsCardProps {
  news: NewsMock;
}

export default function NewsCard({ news }: NewsCardProps) {
  return (
    <motion.a
      href={news.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="glass-card flex gap-3 p-3 transition-colors hover:bg-white/[0.03]"
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      {/* Thumbnail placeholder */}
      <div className="relative h-20 w-20 flex-shrink-0 overflow-hidden rounded-lg bg-bg-tertiary">
        <div className="flex h-full w-full items-center justify-center text-2xl text-text-tertiary">
          📰
        </div>
      </div>

      <div className="flex flex-1 flex-col justify-between min-w-0">
        <p className="text-sm font-medium leading-snug text-text-primary line-clamp-2">
          {news.title}
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          {news.teamId && <TeamBadge teamId={news.teamId} />}
          <span className="text-[11px] text-text-tertiary">
            {news.source}
          </span>
          <span className="text-[11px] text-text-tertiary">·</span>
          <span className="text-[11px] text-text-tertiary">
            {news.timeAgo}
          </span>
          <ExternalLink size={10} className="ml-auto text-text-tertiary" />
        </div>
      </div>
    </motion.a>
  );
}
