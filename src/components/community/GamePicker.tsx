"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase/client";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { Loader2, X } from "lucide-react";
import Image from "next/image";

export interface PickedGame {
  id: string;
  date: string;
  time: string;
  homeTeamId: number;
  awayTeamId: number;
  stadium: string;
  homeScore: number;
  awayScore: number;
  status: string;
}

interface GamePickerProps {
  selectedGameId: string | null;
  onSelect: (game: PickedGame | null) => void;
}

export default function GamePicker({ selectedGameId, onSelect }: GamePickerProps) {
  const [games, setGames] = useState<PickedGame[]>([]);
  const [loading, setLoading] = useState(true);
  const { profile } = useAuth();
  const userTeamId = (profile as Record<string, unknown> | null)?.team_id as number | undefined;

  useEffect(() => {
    async function fetchGames() {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const dateStr = yesterday.toISOString().slice(0, 10);

      const { data } = await supabase
        .from("games")
        .select("id, date, time, home_team_id, away_team_id, stadium, home_score, away_score, status")
        .gte("date", dateStr)
        .order("date", { ascending: false })
        .order("time", { ascending: true })
        .limit(10);

      if (data) {
        const mapped: PickedGame[] = data.map((g) => ({
          id: g.id,
          date: g.date,
          time: g.time,
          homeTeamId: g.home_team_id,
          awayTeamId: g.away_team_id,
          stadium: g.stadium,
          homeScore: g.home_score ?? 0,
          awayScore: g.away_score ?? 0,
          status: g.status,
        }));

        // Sort user's team games first
        if (userTeamId) {
          mapped.sort((a, b) => {
            const aHasTeam = a.homeTeamId === userTeamId || a.awayTeamId === userTeamId;
            const bHasTeam = b.homeTeamId === userTeamId || b.awayTeamId === userTeamId;
            if (aHasTeam && !bHasTeam) return -1;
            if (!aHasTeam && bHasTeam) return 1;
            return 0;
          });
        }

        setGames(mapped);
      }
      setLoading(false);
    }

    fetchGames();
  }, [userTeamId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 size={20} className="animate-spin text-text-tertiary" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text-secondary">경기 연결</p>

      {games.length === 0 && (
        <p className="text-xs text-text-tertiary py-2">최근 경기가 없습니다</p>
      )}

      <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
        {/* No game option */}
        <button
          onClick={() => onSelect(null)}
          className={`flex-shrink-0 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
            selectedGameId === null
              ? "bg-bg-tertiary border border-accent text-accent"
              : "bg-bg-tertiary border border-transparent text-text-secondary"
          }`}
        >
          <X size={14} className="inline mr-1" />
          연결 안 함
        </button>

        {games.map((game) => {
          const home = getTeamById(game.homeTeamId);
          const away = getTeamById(game.awayTeamId);
          const isSelected = selectedGameId === game.id;

          return (
            <button
              key={game.id}
              onClick={() => onSelect(isSelected ? null : game)}
              className={`flex-shrink-0 flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-colors ${
                isSelected
                  ? "bg-bg-tertiary border border-accent"
                  : "bg-bg-tertiary border border-transparent"
              }`}
            >
              {home && (
                <Image src={home.logoPath} alt={home.shortName} width={20} height={20} />
              )}
              <span className="text-text-primary font-medium">
                {home?.shortName ?? "?"} vs {away?.shortName ?? "?"}
              </span>
              {away && (
                <Image src={away.logoPath} alt={away.shortName} width={20} height={20} />
              )}
              <span className="text-text-tertiary">· {game.date.slice(5)} · {game.stadium}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
