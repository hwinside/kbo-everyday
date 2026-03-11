"use client";

import { useState, useMemo } from "react";
import { getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { Search, X } from "lucide-react";
import type { PickedGame } from "./GamePicker";
import { getFavoritePlayers } from "@/lib/store/favorites";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

interface PlayerTag {
  kboId: string;
  name: string;
  teamId: number;
}

interface PlayerTaggerProps {
  game: PickedGame | null;
  selectedPlayers: PlayerTag[];
  onToggle: (player: PlayerTag) => void;
}

function getPlayersForTeam(teamId: number): PlayerTag[] {
  return PLAYERS_ROSTER
    .filter((p) => p.teamId === teamId)
    .map((p) => ({ kboId: p.kboId, name: p.name, teamId: p.teamId }));
}

export default function PlayerTagger({ game, selectedPlayers, onToggle }: PlayerTaggerProps) {
  const [search, setSearch] = useState("");

  const players = useMemo(() => {
    if (game) {
      return [
        ...getPlayersForTeam(game.homeTeamId),
        ...getPlayersForTeam(game.awayTeamId),
      ];
    }
    // No game: show all players, filter by search
    return PLAYERS_ROSTER.map((p) => ({ kboId: p.kboId, name: p.name, teamId: p.teamId }));
  }, [game]);

  const { profile } = useAuth();
  const userTeamId = (profile as Record<string, unknown> | null)?.team_id as number | undefined;

  // Dedupe players by kboId, sort user's team first
  const uniquePlayers = useMemo(() => {
    const seen = new Set<string>();
    const deduped = players.filter((p) => {
      if (seen.has(p.kboId)) return false;
      seen.add(p.kboId);
      return true;
    });
    if (userTeamId) {
      deduped.sort((a, b) => {
        const aIsMyTeam = a.teamId === userTeamId ? 0 : 1;
        const bIsMyTeam = b.teamId === userTeamId ? 0 : 1;
        return aIsMyTeam - bIsMyTeam;
      });
    }
    return deduped;
  }, [players, userTeamId]);

  const isSelected = (kboId: string) => selectedPlayers.some((p) => p.kboId === kboId);

  // Filter by search + exclude already selected
  const filtered = uniquePlayers
    .filter((p) => !isSelected(p.kboId))
    .filter((p) => !search || p.name.includes(search));

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text-secondary">선수 태그</p>

      {/* Selected chips (above input) */}
      {selectedPlayers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedPlayers.map((p) => (
            <button
              key={p.kboId}
              onClick={() => onToggle(p)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-accent/20 text-accent"
            >
              {p.name}
              <X size={12} />
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <input
          type="text"
          placeholder="선수 이름 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered.length > 0) {
              e.preventDefault();
              onToggle(filtered[0]);
              setSearch("");
            }
          }}
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
        />

        {/* Dropdown results on search */}
        {search && (
          <div className="absolute z-10 left-0 right-0 top-full mt-1 bg-bg-secondary rounded-xl border border-border shadow-lg max-h-[200px] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-text-tertiary px-4 py-3">검색 결과 없음</p>
            ) : (
              filtered.slice(0, 20).map((p) => {
                const team = getTeamById(p.teamId);
                return (
                  <button
                    key={p.kboId}
                    onClick={() => { onToggle(p); setSearch(""); }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-text-primary hover:bg-bg-tertiary active:bg-bg-tertiary transition-colors text-left"
                  >
                    {team && (
                      <span className="text-xs text-text-tertiary min-w-[28px]">{team.shortName}</span>
                    )}
                    <span>{p.name}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Favorite players only (no search) — rest via search */}
      {!search && (() => {
        const favorites = getFavoritePlayers();
        const favoriteIds = new Set(favorites.map((f) => f.playerId));
        const favoritePlayers = favoriteIds.size > 0
          ? filtered.filter((p) => favoriteIds.has(p.kboId))
          : [];
        
        if (favoritePlayers.length === 0) return null;
        
        return (
          <div className="flex flex-wrap gap-1.5">
            {favoritePlayers.map((p) => {
              const team = getTeamById(p.teamId);
              return (
                <button
                  key={p.kboId}
                  onClick={() => onToggle(p)}
                  className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors bg-bg-tertiary text-text-secondary"
                >
                  {team?.shortName && (
                    <span className="text-text-tertiary mr-0.5">{team.shortName}</span>
                  )}
                  {p.name}
                </button>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}
