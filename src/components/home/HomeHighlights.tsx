"use client";

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { TEAMS } from "@/lib/constants/teams";
import { getFavoritePlayers } from "@/lib/store/favorites";

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
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(() => {
    if (!team) { setLoading(false); return; }

    let favPlayers = getFavoritePlayers().slice(0, 3);
    
    // fallback 대표선수
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

      // 선수별 각 2개씩, 팀으로 나머지 채우기
      const perPlayer = playerResults.map(d => dedup((d.items || []).slice(0, 2)));
      const playerVideos = perPlayer.flat();
      const teamVideos = dedup((results[0]?.items || []).slice(0, Math.max(6 - playerVideos.length, 1)));
      const all = [...playerVideos, ...teamVideos];

      // 최신순
      all.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      setVideos(all.slice(0, 6));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [team]);

  if (loading || videos.length === 0) return null;

  return (
    <section className="px-5 mt-6">
      <h2 className="text-lg font-bold text-text-primary mb-3">🎬 하이라이트</h2>
      <div className="grid grid-cols-2 gap-3">
        {videos.map(v => (
          <div key={v.id}>
            {playingId === v.id ? (
              <div className="relative aspect-video rounded-xl overflow-hidden">
                <iframe
                  src={`https://www.youtube.com/embed/${v.id}?autoplay=1&controls=0&rel=0`}
                  className="absolute inset-0 w-full h-full"
                  allow="autoplay"
                  allowFullScreen
                />
              </div>
            ) : (
              <div
                className="relative aspect-video rounded-xl overflow-hidden cursor-pointer group"
                onClick={() => setPlayingId(v.id)}
              >
                <img src={v.thumbnail} alt={v.title} className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/40 transition">
                  <Play size={32} className="text-white fill-white" />
                </div>
                {v.label && (
                  <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-accent/80 text-[10px] font-semibold text-white">
                    {v.label}
                  </span>
                )}
              </div>
            )}
            <p className="text-xs text-text-secondary mt-1.5 line-clamp-2 leading-snug">{v.title}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
