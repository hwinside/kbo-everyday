"use client";

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { TEAMS } from "@/lib/constants/teams";

interface Video {
  id: string;
  title: string;
  thumbnail: string;
  publishedAt: string;
}

interface HomeOfficialVideosProps {
  team: string | null;
}

export default function HomeOfficialVideos({ team }: HomeOfficialVideosProps) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!team) { setLoading(false); return; }

    const teamObj = TEAMS.find(t => t.shortName === team);
    const teamSlug = teamObj?.slug || team;

    fetch(`/api/team-videos?team=${encodeURIComponent(teamSlug)}&type=long`)
      .then(r => r.json())
      .then(d => {
        setVideos(d.items || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [team]);

  if (loading || videos.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold leading-[26px] text-text-primary mb-3">📺 공식 영상</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
        {videos.slice(0, 10).map((v) => (
          <a
            key={v.id}
            href={`https://www.youtube.com/watch?v=${v.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 group"
          >
            <div className="relative w-[220px] rounded-xl overflow-hidden">
              <img
                src={v.thumbnail}
                alt={v.title}
                className="w-full aspect-video object-cover group-hover:scale-105 transition-transform"
              />
              <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                <div className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center">
                  <Play size={18} className="text-black ml-0.5" fill="black" />
                </div>
              </div>
            </div>
            <p className="mt-2 text-xs text-text-secondary line-clamp-2 w-[220px] leading-relaxed">
              {v.title}
            </p>
          </a>
        ))}
      </div>
    </section>
  );
}
