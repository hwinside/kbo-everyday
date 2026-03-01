"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { Heart, MessageCircle, Share2, Eye, Play } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import { MOCK_HIGHLIGHTS, formatCount, HIGHLIGHT_TYPES, type Highlight } from "@/lib/constants/highlights";
import { getMyTeamId } from "@/lib/store/myteam";

type FilterTab = "all" | "my" | "highlight" | "interview" | "analysis";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

function ReelCard({ reel, onPlay }: { reel: Highlight; onPlay: () => void }) {
  const team = getTeamById(reel.teamId)!;
  const typeInfo = HIGHLIGHT_TYPES[reel.type];

  return (
    <motion.div
      variants={item}
      className="glass-card overflow-hidden"
    >
      {/* Thumbnail */}
      <button
        onClick={onPlay}
        className="relative w-full aspect-video bg-bg-tertiary flex items-center justify-center group"
        style={{ background: `linear-gradient(135deg, ${team.colorPrimary}30, ${team.colorPrimary}08)` }}
      >
        {/* Team logo watermark */}
        <div className="absolute inset-0 flex items-center justify-center opacity-10">
          <Image src={team.logoPath} alt="" width={120} height={120} unoptimized className="object-contain" />
        </div>

        {/* Play button */}
        <div className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm group-hover:bg-white/30 transition-colors">
          <Play size={24} fill="white" className="text-white ml-1" />
        </div>

        {/* Duration */}
        <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums">
          {reel.duration}
        </span>

        {/* Type badge */}
        <span className="absolute top-2 left-2 rounded-full px-2 py-0.5 text-xs font-semibold bg-black/50 text-white backdrop-blur-sm">
          {typeInfo.emoji} {typeInfo.label}
        </span>
      </button>

      {/* Info */}
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Team logo */}
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-white p-1 flex items-center justify-center mt-0.5">
            <Image src={team.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
          </div>

          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-text-primary line-clamp-2 leading-snug">{reel.title}</h3>
            <p className="mt-1 text-xs text-text-tertiary">
              {reel.channel} · {reel.timeAgo}
            </p>
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-3 flex items-center gap-4 text-xs text-text-tertiary">
          <span className="flex items-center gap-1">
            <Eye size={13} /> {formatCount(reel.viewCount)}
          </span>
          <span className="flex items-center gap-1">
            <Heart size={13} /> {formatCount(reel.likeCount)}
          </span>
          <span className="flex items-center gap-1">
            <MessageCircle size={13} /> {formatCount(reel.commentCount)}
          </span>
          <button className="ml-auto flex items-center gap-1 hover:text-text-secondary transition-colors">
            <Share2 size={13} /> 공유
          </button>
        </div>
      </div>
    </motion.div>
  );
}

export default function HighlightsPage() {
  const [filter, setFilter] = useState<FilterTab>("all");
  const [myTeamId, setMyTeam] = useState<number | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(() => {
    setMyTeam(getMyTeamId());
  }, []);

  const filtered = MOCK_HIGHLIGHTS.filter((h) => {
    if (filter === "my") return h.teamId === myTeamId;
    if (filter === "highlight") return h.type === "highlight";
    if (filter === "interview") return h.type === "interview";
    if (filter === "analysis") return h.type === "analysis" || h.type === "vlog";
    return true;
  });

  // 마이팀 영상 우선 정렬
  const sorted = [...filtered].sort((a, b) => {
    if (filter === "all" && myTeamId) {
      if (a.teamId === myTeamId && b.teamId !== myTeamId) return -1;
      if (b.teamId === myTeamId && a.teamId !== myTeamId) return 1;
    }
    return 0;
  });

  const filters: { key: FilterTab; label: string }[] = [
    { key: "all", label: "전체" },
    { key: "my", label: "MY팀" },
    { key: "highlight", label: "🔥 하이라이트" },
    { key: "interview", label: "🎤 인터뷰" },
    { key: "analysis", label: "📊 분석" },
  ];

  return (
    <div className="mx-auto max-w-lg pt-safe">
      {/* Header */}
      <div className="px-5 py-4">
        <h1 className="text-xl font-bold text-text-primary">영상</h1>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 overflow-x-auto hide-scrollbar px-5 pb-3">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              filter === f.key
                ? "bg-accent text-white"
                : "bg-bg-tertiary text-text-secondary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Video feed */}
      <motion.div
        key={filter}
        variants={container}
        initial="hidden"
        animate="show"
        className="px-5 pb-24 space-y-4"
      >
        {sorted.map((reel) => (
          <ReelCard
            key={reel.id}
            reel={reel}
            onPlay={() => setPlayingId(reel.id)}
          />
        ))}

        {sorted.length === 0 && (
          <div className="py-20 text-center text-text-tertiary text-sm">
            영상이 없습니다
          </div>
        )}
      </motion.div>

      {/* Video player modal */}
      <AnimatePresence>
        {playingId && (() => {
          const reel = MOCK_HIGHLIGHTS.find(h => h.id === playingId);
          if (!reel) return null;
          const team = getTeamById(reel.teamId)!;
          return (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 bg-black/90"
                onClick={() => setPlayingId(null)}
              />
              <motion.div
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 30, stiffness: 300 }}
                className="fixed inset-x-0 bottom-0 z-50 bg-bg-secondary rounded-t-2xl overflow-hidden"
                style={{ maxHeight: "90vh" }}
              >
                <div className="flex justify-center pt-2">
                  <div className="h-1 w-10 rounded-full bg-text-tertiary" />
                </div>

                {/* YouTube embed placeholder */}
                <div className="w-full aspect-video bg-black flex items-center justify-center">
                  <div className="text-center">
                    <div
                      className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full"
                      style={{ backgroundColor: `${team.colorPrimary}30` }}
                    >
                      <Play size={32} className="text-white ml-1" />
                    </div>
                    <p className="text-sm text-text-tertiary">YouTube 연동 후 재생됩니다</p>
                    <p className="text-xs text-text-tertiary mt-1">youtube.com/watch?v={reel.youtubeId}</p>
                  </div>
                </div>

                <div className="p-5">
                  <h2 className="text-base font-bold text-text-primary">{reel.title}</h2>
                  <p className="mt-1 text-sm text-text-secondary">{reel.description}</p>
                  <div className="mt-3 flex items-center gap-4 text-xs text-text-tertiary">
                    <span className="flex items-center gap-1"><Eye size={13} /> {formatCount(reel.viewCount)}</span>
                    <span className="flex items-center gap-1"><Heart size={13} /> {formatCount(reel.likeCount)}</span>
                    <span className="flex items-center gap-1"><MessageCircle size={13} /> {formatCount(reel.commentCount)}</span>
                  </div>
                  <div className="mt-4 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-white p-1 flex items-center justify-center">
                      <Image src={team.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-text-primary">{reel.channel}</p>
                      <p className="text-xs text-text-tertiary">{reel.timeAgo}</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            </>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
