"use client";

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { getFavoritePlayers } from "@/lib/store/favorites";
import { TEAMS } from "@/lib/constants/teams";
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

    // 팀 slug 찾기 (공식채널 숏츠 호출용)
    const teamObj = TEAMS.find(t => t.shortName === team);
    const teamSlug = teamObj?.slug || team;

    // 2개 소스 병렬 호출:
    // 1) 기존 하이라이트 (검색 기반)
    // 2) 팀 공식 유튜브 채널 숏츠
    Promise.all([
      fetch(`/api/highlights?team=${encodeURIComponent(team)}`)
        .then(r => r.json())
        .catch(() => ({ items: [] })),
      fetch(`/api/team-videos?team=${encodeURIComponent(teamSlug)}&type=short`)
        .then(r => r.json())
        .catch(() => ({ items: [] })),
    ]).then(([highlightData, officialData]) => {
      const seen = new Set<string>();

      // 하이라이트 영상 (최애선수 레이블링)
      const highlightItems: VideoItem[] = (highlightData.items || [])
        .map((v: any) => {
          const matchedPlayer = favNames.find(name => v.title.includes(name));
          return { ...v, label: matchedPlayer || team };
        })
        .filter((v: VideoItem) => {
          if (seen.has(v.id)) return false;
          seen.add(v.id);
          return true;
        });

      // 공식채널 숏츠 (channel 정보 추가)
      const officialItems: VideoItem[] = (officialData.items || [])
        .map((v: any) => ({
          id: v.id,
          title: v.title,
          thumbnail: v.thumbnail,
          channel: teamObj?.name || team,
          publishedAt: v.publishedAt,
          label: "공식",
        }))
        .filter((v: VideoItem) => {
          if (seen.has(v.id)) return false;
          seen.add(v.id);
          return true;
        });

      // 합치고 최신순 정렬
      const merged = [...highlightItems, ...officialItems]
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
        .slice(0, 30);

      setVideos(merged);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [team]);

  if (loading || videos.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold leading-[26px] text-text-primary mb-3">🎬 내 팀, 최애선수 숏츠</h2>
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
                <span className={`absolute top-2 left-2 px-1.5 py-0.5 rounded-full text-xs font-semibold text-white ${
                  v.label === "공식" ? "bg-blue-500/80" : "bg-accent/80"
                }`}>
                  {v.label}
                </span>
              )}
              <p className="absolute bottom-2 left-2 right-2 text-xs leading-[18px] text-white font-medium line-clamp-2">
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
