"use client";

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { getFavoritePlayers } from "@/lib/store/favorites";
import ReelViewer from "@/components/home/ReelViewer";

interface VideoItem {
  id: string;
  title: string;
  thumbnail: string;
  channel: string;
  publishedAt: string;
  label?: string;
}

interface HomeHighlightsProps {
  team: string | null;
}

export default function HomeHighlights({ team }: HomeHighlightsProps) {
  const [reelIndex, setReelIndex] = useState<number | null>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!team) { setLoading(false); return; }

    const favPlayers = getFavoritePlayers().slice(0, 5);
    const favNames = favPlayers.map(p => p.name);

    // 팀 쿼리 1개 → 서버에서 팀+스타선수 2쿼리 자동 실행
    fetch(`/api/highlights?team=${encodeURIComponent(team)}`)
      .then(r => r.json())
      .then(data => {
        const items: VideoItem[] = (data.items || []).map((v: any) => {
          // 최애선수 이름이 제목에 있으면 레이블
          const matchedPlayer = favNames.find(name => v.title.includes(name));
          return { ...v, label: matchedPlayer || team };
        });

        // 최애선수 영상 우선
        const playerVids = items.filter(v => v.label !== team);
        const teamVids = items.filter(v => v.label === team);
        setVideos([...playerVids, ...teamVids].slice(0, 30));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [team]);

  if (loading || videos.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-lg font-bold text-text-primary mb-3">🎬 하이라이트</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide" style={{ scrollSnapType: "x mandatory" }}>
        {videos.slice(0, 10).map((v, i) => (
          <div
            key={v.id}
            className="flex-shrink-0 cursor-pointer"
            style={{ width: "140px", scrollSnapAlign: "start" }}
            onClick={() => setReelIndex(i)}
          >
            <div className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "9/16", width: "140px" }}>
              <img src={v.thumbnail} alt={v.title} className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Play size={28} className="text-white fill-white opacity-80" />
              </div>
              {v.label && (
                <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded-full bg-accent/80 text-[10px] font-semibold text-white">
                  {v.label}
                </span>
              )}
              <p className="absolute bottom-2 left-2 right-2 text-[11px] text-white font-medium line-clamp-2 leading-tight">
                {v.title}
              </p>
            </div>
          </div>
        ))}
      </div>

      {reelIndex !== null && (
        <ReelViewer
          videos={videos}
          startIndex={reelIndex}
          onClose={() => setReelIndex(null)}
        />
      )}
    </section>
  );
}
