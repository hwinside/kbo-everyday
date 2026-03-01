"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { Play, X } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import { HIGHLIGHTS, HIGHLIGHT_TYPES, type Highlight } from "@/lib/constants/highlights";
import { getMyTeamId } from "@/lib/store/myteam";

type FilterTab = "all" | "my" | "highlight" | "interview" | "analysis";

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } };

function ReelCard({ reel, onPlay }: { reel: Highlight; onPlay: () => void }) {
  const team = reel.teamId ? getTeamById(reel.teamId) : null;
  const typeInfo = HIGHLIGHT_TYPES[reel.type];

  return (
    <motion.div variants={item} className="glass-card overflow-hidden">
      {/* YouTube thumbnail */}
      <button onClick={onPlay} className="relative w-full aspect-video bg-bg-tertiary group">
        <img
          src={reel.thumbnail}
          alt={reel.title}
          className="w-full h-full object-cover"
        />
        {/* Play overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600/90 shadow-lg">
            <Play size={24} fill="white" className="text-white ml-1" />
          </div>
        </div>
        {/* Type badge */}
        <span className="absolute top-2 left-2 rounded-full px-2 py-0.5 text-xs font-semibold bg-black/60 text-white backdrop-blur-sm">
          {typeInfo.emoji} {typeInfo.label}
        </span>
        {/* Team badge */}
        {team && (
          <div className="absolute top-2 right-2 w-7 h-7 rounded-full bg-white/90 p-0.5 flex items-center justify-center">
            <Image src={team.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
          </div>
        )}
      </button>

      {/* Info */}
      <div className="p-3.5">
        <h3 className="text-sm font-bold text-text-primary line-clamp-2 leading-snug">{reel.title}</h3>
        <p className="mt-1.5 text-xs text-text-tertiary">{reel.channel} · {reel.timeAgo}</p>
      </div>
    </motion.div>
  );
}

export default function HighlightsPage() {
  const [filter, setFilter] = useState<FilterTab>("all");
  const [myTeamId, setMyTeam] = useState<number | null>(null);
  const [playingReel, setPlayingReel] = useState<Highlight | null>(null);

  useEffect(() => {
    setMyTeam(getMyTeamId());
  }, []);

  // body scroll lock
  useEffect(() => {
    if (playingReel) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [playingReel]);

  const filtered = HIGHLIGHTS.filter((h) => {
    if (filter === "my") return h.teamId === myTeamId;
    if (filter === "highlight") return h.type === "highlight";
    if (filter === "interview") return h.type === "interview";
    if (filter === "analysis") return h.type === "analysis" || h.type === "vlog";
    return true;
  });

  // 마이팀 우선
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
      <div className="px-5 py-4">
        <h1 className="text-xl font-bold text-text-primary">영상</h1>
      </div>

      <div className="flex gap-2 overflow-x-auto hide-scrollbar px-5 pb-3">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              filter === f.key ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <motion.div key={filter} variants={container} initial="hidden" animate="show" className="px-5 pb-24 space-y-4">
        {sorted.map((reel) => (
          <ReelCard key={reel.id} reel={reel} onPlay={() => setPlayingReel(reel)} />
        ))}
        {sorted.length === 0 && (
          <div className="py-20 text-center text-text-tertiary text-sm">영상이 없습니다</div>
        )}
      </motion.div>

      {/* YouTube Player Modal */}
      <AnimatePresence>
        {playingReel && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/95"
              onClick={() => setPlayingReel(null)}
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="fixed inset-x-0 bottom-0 z-50 bg-bg-secondary rounded-t-2xl overflow-y-auto overscroll-contain"
              style={{ maxHeight: "85vh" }}
            >
              <div className="flex justify-center pt-2 pb-1">
                <div className="h-1 w-10 rounded-full bg-text-tertiary" />
              </div>

              {/* YouTube iframe embed */}
              <div className="w-full aspect-video bg-black">
                <iframe
                  src={`https://www.youtube.com/embed/${playingReel.youtubeId}?autoplay=1&rel=0`}
                  title={playingReel.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="w-full h-full"
                />
              </div>

              <div className="p-5">
                <h2 className="text-base font-bold text-text-primary leading-snug">{playingReel.title}</h2>
                <div className="mt-2 flex items-center gap-3">
                  {playingReel.teamId && (() => {
                    const team = getTeamById(playingReel.teamId);
                    return team ? (
                      <div className="w-6 h-6 rounded-full bg-white p-0.5 flex items-center justify-center">
                        <Image src={team.logoPath} alt="" width={16} height={16} unoptimized className="object-contain" />
                      </div>
                    ) : null;
                  })()}
                  <p className="text-sm text-text-secondary">{playingReel.channel}</p>
                  <span className="text-xs text-text-tertiary">{playingReel.timeAgo}</span>
                </div>

                <button
                  onClick={() => setPlayingReel(null)}
                  className="mt-4 w-full py-2.5 rounded-xl bg-bg-tertiary text-sm font-medium text-text-secondary hover:bg-bg-tertiary/80 transition-colors"
                >
                  닫기
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
