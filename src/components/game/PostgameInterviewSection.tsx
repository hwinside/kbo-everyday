"use client";

import { useCallback, useEffect, useState } from "react";
import { Play } from "lucide-react";
import Link from "next/link";
import { handleExternalAnchorClick } from "@/lib/open-external";
import { getTeamById } from "@/lib/constants/teams";

interface InterviewPlayer {
  name: string;
  kboId: string | null;
  teamId: number;
}

interface InterviewVideo {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  playerNames: string[];
  players?: InterviewPlayer[];
  sourceKind: "broadcaster" | "team" | "curated";
}

interface InterviewResponse {
  items?: InterviewVideo[];
  collecting?: boolean;
}

export default function PostgameInterviewSection({
  gameId,
  enabled,
}: {
  gameId: string;
  enabled: boolean;
}) {
  const [items, setItems] = useState<InterviewVideo[]>([]);
  const [collecting, setCollecting] = useState(false);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await fetch(`/api/game-interviews?gameId=${encodeURIComponent(gameId)}`);
      if (!response.ok) return;
      const json = await response.json() as InterviewResponse;
      setItems(json.items ?? []);
      setCollecting(json.collecting === true);
    } catch {
      // 인터뷰 보조 영역 실패가 경기 상세를 막지 않는다.
    }
  }, [enabled, gameId]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || !collecting) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5 * 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [collecting, enabled, load]);

  if (!enabled || items.length === 0) return null;

  return (
    <section className="px-4 pt-3 pb-4" aria-label="수훈선수 인터뷰">
      <h2 className="mb-2.5 text-[15px] font-semibold text-text-primary">수훈선수 인터뷰</h2>
      <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-hide">
        {items.map((item) => {
          const url = `https://www.youtube.com/watch?v=${item.videoId}`;
          const players = item.players
            ?? item.playerNames.map((name) => ({ name, kboId: null, teamId: 0 }));
          return (
            <article key={item.videoId} className="w-[236px] shrink-0">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => handleExternalAnchorClick(event, url)}
                aria-label={`${item.title} YouTube에서 보기`}
              >
                <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-bg-tertiary">
                  {item.thumbnail && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.thumbnail}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90">
                      <Play size={18} className="ml-0.5 text-black" fill="black" />
                    </span>
                  </div>
                </div>
              </a>
              {players.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label="인터뷰 선수">
                  {players.map((player) => {
                    const team = getTeamById(player.teamId);
                    const teamColor = team?.colorLight ?? "var(--accent)";
                    const className = "rounded-full bg-bg-tertiary px-2 py-1 text-xs font-semibold";
                    const style = {
                      color: teamColor,
                      ...(team ? { backgroundColor: `${teamColor}1F` } : {}),
                    };
                    return player.kboId ? (
                      <Link
                        key={`${player.kboId}:${player.name}`}
                        href={`/community/players/${player.kboId}`}
                        prefetch={false}
                        className={className}
                        style={style}
                      >
                        {player.name}
                      </Link>
                    ) : (
                      <span key={player.name} className={className} style={style}>
                        {player.name}
                      </span>
                    );
                  })}
                </div>
              )}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => handleExternalAnchorClick(event, url)}
                className="mt-1.5 block"
              >
                <p className="line-clamp-2 text-sm leading-snug text-text-primary">
                  {item.title}
                </p>
              </a>
              <p className="mt-1 text-xs text-text-tertiary">
                {item.channel}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
