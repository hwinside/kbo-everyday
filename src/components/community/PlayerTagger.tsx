"use client";

import { useState, useMemo } from "react";
import { getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { Search, X } from "lucide-react";
import type { PickedGame } from "./GamePicker";

// Import all player data from constants
import * as playerData from "@/lib/constants/players";

interface PlayerTag {
  id: number;
  name: string;
  teamId: number;
}

interface PlayerTaggerProps {
  game: PickedGame | null;
  selectedPlayers: PlayerTag[];
  onToggle: (player: PlayerTag) => void;
}

function getPlayersForTeam(teamId: number): PlayerTag[] {
  // Search through all exported arrays in players.ts for matching teamId
  const allPlayers: PlayerTag[] = [];
  for (const [, value] of Object.entries(playerData)) {
    if (Array.isArray(value)) {
      for (const p of value) {
        if (p && typeof p === "object" && "teamId" in p && p.teamId === teamId) {
          allPlayers.push({ id: p.id, name: p.name, teamId: p.teamId });
        }
      }
    }
  }
  return allPlayers;
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
    const all: PlayerTag[] = [];
    for (const [, value] of Object.entries(playerData)) {
      if (Array.isArray(value)) {
        for (const p of value) {
          if (p && typeof p === "object" && "teamId" in p) {
            all.push({ id: p.id, name: p.name, teamId: p.teamId });
          }
        }
      }
    }
    return all;
  }, [game]);

  const { profile } = useAuth();
  const userTeamId = (profile as Record<string, unknown> | null)?.team_id as number | undefined;

  // Dedupe players by id, sort user's team first
  const uniquePlayers = useMemo(() => {
    const seen = new Set<number>();
    const deduped = players.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
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

  const isSelected = (id: number) => selectedPlayers.some((p) => p.id === id);

  // Filter by search + exclude already selected
  const filtered = uniquePlayers
    .filter((p) => !isSelected(p.id))
    .filter((p) => !search || p.name.includes(search));

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text-secondary">선수 태그</p>

      {/* Selected chips (above input) */}
      {selectedPlayers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedPlayers.map((p) => (
            <button
              key={p.id}
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
              const first = filtered[0];
              if (!isSelected(first.id)) onToggle(first);
              setSearch("");
            }
          }}
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
        />
      </div>

      {/* Player grid */}
      <div className="flex flex-wrap gap-1.5 max-h-[120px] overflow-y-auto">
        {filtered.slice(0, 30).map((p) => {
          const team = getTeamById(p.teamId);
          const selected = isSelected(p.id);
          return (
            <button
              key={p.id}
              onClick={() => onToggle(p)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                selected
                  ? "bg-accent/20 text-accent"
                  : "bg-bg-tertiary text-text-secondary"
              }`}
            >
              {team?.shortName && (
                <span className="text-text-tertiary mr-0.5">{team.shortName}</span>
              )}
              {p.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
