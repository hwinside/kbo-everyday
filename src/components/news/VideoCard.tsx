"use client";

import { motion } from "framer-motion";
import { Play, Eye } from "lucide-react";
import TeamBadge from "@/components/ui/TeamBadge";
import { formatViewCount, type VideoMock } from "@/lib/constants/news";

interface VideoCardProps {
  video: VideoMock;
}

export default function VideoCard({ video }: VideoCardProps) {
  return (
    <motion.div
      className="glass-card overflow-hidden transition-colors hover:bg-white/[0.03]"
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video w-full bg-bg-tertiary">
        <div className="flex h-full w-full items-center justify-center">
          <span className="text-4xl text-text-tertiary">🎬</span>
        </div>
        {/* Play button overlay */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm">
            <Play size={20} className="ml-0.5 text-white" fill="white" />
          </div>
        </div>
        {/* Duration badge - mock */}
        <div className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
          10:24
        </div>
      </div>

      {/* Info */}
      <div className="p-3">
        <p className="text-sm font-medium leading-snug text-text-primary line-clamp-2">
          {video.title}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <TeamBadge teamId={video.teamId} />
          <span className="text-[11px] text-text-tertiary">{video.channelName}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-text-tertiary">
          <span className="flex items-center gap-0.5">
            <Eye size={10} />
            조회수 {formatViewCount(video.viewCount)}
          </span>
          <span>·</span>
          <span>{video.timeAgo}</span>
        </div>
      </div>
    </motion.div>
  );
}
