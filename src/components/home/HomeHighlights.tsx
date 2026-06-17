"use client";

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { getFavoritePlayers } from "@/lib/store/favorites";
import { TEAMS } from "@/lib/constants/teams";
import ReelViewer from "@/components/home/ReelViewer";
import { getShortsVisible, SHORTS_PREF_EVENT } from "@/lib/store/shorts-pref";

/** team shortName lookup by various keys */
const TEAM_LABEL: Record<string, string> = {};
for (const t of TEAMS) {
  TEAM_LABEL[String(t.id)] = t.shortName;
  TEAM_LABEL[t.shortName] = t.shortName;
  TEAM_LABEL[t.slug] = t.shortName;
}

interface VideoItem {
  id: string;
  title: string;
  thumbnail: string;
  channel: string;
  publishedAt: string;
  playerIds: string[];
  teamId: string | null;
  isPlayerMatch: boolean;
  hasPlayerTag: boolean;
  label: string;
}

interface HomeHighlightsProps {
  team: string | null;
}

export default function HomeHighlights({ team }: HomeHighlightsProps) {
  const [reelIndex, setReelIndex] = useState<number | null>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [shortsVisible, setShortsVisible] = useState(true);

  // 마이페이지 '숏츠 표시' 토글 반영 (기기 로컬 설정, 변경 즉시 반영)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShortsVisible(getShortsVisible());
    const onChange = () => setShortsVisible(getShortsVisible());
    window.addEventListener(SHORTS_PREF_EVENT, onChange);
    return () => window.removeEventListener(SHORTS_PREF_EVENT, onChange);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!team) { setLoading(false); return; }

    const favPlayers = getFavoritePlayers().slice(0, 5);
    const favPlayerMap = new Map(favPlayers.map(p => [p.playerId, p.name]));
    const playerIdsParam = favPlayers.length > 0
      ? `&player_ids=${encodeURIComponent(favPlayers.map(p => p.playerId).join(","))}`
      : "";

    fetch(`/api/shorts-feed?team=${encodeURIComponent(team)}${playerIdsParam}`)
      .then(r => r.json())
      .then((data) => {
        const items: VideoItem[] = (data.items || []).map((v: any) => {
          // Label: 최애선수명 > 태깅된 선수명 > 팀명 > 없음
          const matchedPlayer = (v.playerIds ?? []).find((id: string) => favPlayerMap.has(id));
          const teamLabel = v.teamId ? (TEAM_LABEL[v.teamId] ?? null) : null;
          const label = matchedPlayer
            ? favPlayerMap.get(matchedPlayer)!
            : v.playerName ?? teamLabel ?? "";
          const isPlayerMatch = !!matchedPlayer;
          const hasPlayerTag = !matchedPlayer && !!v.playerName;

          return {
            id: v.id,
            title: v.title,
            thumbnail: v.thumbnail,
            channel: v.channel,
            publishedAt: v.publishedAt,
            playerIds: v.playerIds ?? [],
            teamId: v.teamId ?? null,
            isPlayerMatch,
            hasPlayerTag,
            label,
          };
        });
        setVideos(items.slice(0, 30));
        setLoading(false);
      }).catch(() => setLoading(false));
  }, [team]);

  if (loading || videos.length === 0 || !shortsVisible) return null;

  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold leading-[26px] text-text-primary mb-3">🎬 내 팀, 최애선수 숏츠</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide" style={{ scrollSnapType: "x mandatory" }}>
        {videos.slice(0, 15).map((v, i) => (
          <div
            key={v.id}
            className="flex-shrink-0 cursor-pointer"
            style={{ width: "140px", scrollSnapAlign: "start" }}
            onClick={() => setReelIndex(i)}
          >
            <div className="relative rounded-xl overflow-hidden" style={{ aspectRatio: "9/16", width: "140px" }}>
              <img src={v.thumbnail} alt={v.title} className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/40 dark:from-black/60 via-transparent to-transparent" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Play size={28} className="text-white fill-white opacity-80" />
              </div>
              {v.label && (
                <span className={`absolute top-2 left-2 px-1.5 py-0.5 rounded-full text-xs font-semibold text-white ${
                  v.isPlayerMatch ? "bg-rose-500/80" : v.hasPlayerTag ? "bg-amber-500/80" : "bg-blue-500/80"
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
