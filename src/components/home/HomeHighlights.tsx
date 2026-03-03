"use client";

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { TEAMS } from "@/lib/constants/teams";
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

    let favPlayers = getFavoritePlayers().slice(0, 3);
    
    if (favPlayers.length === 0) {
      const defaults: Record<string, string[]> = {
        "LG": ["오스틴", "문보경", "홍창기"],
        "두산": ["양의지", "허경민", "곽빈"],
        "KT": ["강백호", "로하스", "소형준"],
        "SSG": ["최정", "추신수", "김광현"],
        "NC": ["손아섭", "박건우", "에릭"],
        "KIA": ["김도영", "나성범", "양현종"],
        "삼성": ["구자욱", "김영웅", "원태인"],
        "롯데": ["전준우", "레이예스", "윌커슨"],
        "한화": ["노시환", "이범호", "주현상"],
        "키움": ["이정후", "김하성", "송성문"],
      };
      const names = defaults[team] || [];
      const teamObj = TEAMS.find(t => t.shortName === team);
      favPlayers = names.map(n => ({ playerId: "", name: n, teamId: teamObj?.id || 0, position: "", number: 0 }));
    }

    const teamObj = TEAMS.find(t => t.shortName === team);
    const teamFullName = teamObj ? `${team} ${teamObj.name}` : team;

    const queries = [
      fetch(`/api/highlights?q=${encodeURIComponent(`${teamFullName} 하이라이트`)}`).then(r => r.json()).then(d => ({
        items: (d.items || []).map((v: any) => ({ ...v, label: team })),
      })),
      ...favPlayers.map(p => {
        const pTeam = TEAMS.find(t => t.id === p.teamId);
        const pName = pTeam ? `${pTeam.shortName} ${p.name}` : p.name;
        return fetch(`/api/highlights?q=${encodeURIComponent(`${pName} 하이라이트`)}`).then(r => r.json()).then(d => ({
          items: (d.items || []).map((v: any) => ({ ...v, label: p.name })),
        }));
      })
    ];

    Promise.all(queries).then(results => {
      const playerResults = results.slice(1);
      const seen = new Set();
      const dedup = (items: any[]) => items.filter((v: any) => {
        if (seen.has(v.id)) return false;
        seen.add(v.id);
        return true;
      });

      const perPlayer = playerResults.map(d => dedup((d.items || []).slice(0, 8)));
      const playerVideos = perPlayer.flat();
      const teamVideos = dedup((results[0]?.items || []).slice(0, Math.max(30 - playerVideos.length, 5)));
      const all = [...playerVideos, ...teamVideos];

      all.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      setVideos(all.slice(0, 30));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [team]);

  if (loading || videos.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-lg font-bold text-text-primary mb-3 px-5">🎬 하이라이트</h2>
      <div className="flex gap-3 overflow-x-auto px-5 pb-2 scrollbar-hide" style={{ scrollSnapType: "x mandatory" }}>
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
