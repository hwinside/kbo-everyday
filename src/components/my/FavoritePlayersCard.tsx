"use client";

import { Star, ChevronRight } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import type { FavoritePlayer } from "@/lib/store/favorites";

interface FavoritePlayersCardProps {
  favPlayers: FavoritePlayer[];
  onEdit: () => void;
}

export default function FavoritePlayersCard({ favPlayers, onEdit }: FavoritePlayersCardProps) {
  return (
    <GlassCard
      pressable
      className="p-5"
      onClick={onEdit}
    >
      <div className="flex items-center gap-4 mb-3">
        <Star size={22} className="text-yellow-400" />
        <span className="text-base text-text-primary">최애 선수</span>
        <ChevronRight size={18} className="ml-auto text-text-tertiary" />
      </div>
      {favPlayers.length > 0 ? (
        <div className="flex gap-3">
          {favPlayers.map(p => (
            <div key={p.playerId} className="flex flex-col items-center gap-1">
              <PlayerAvatar name={p.name} teamId={p.teamId} photoUrl={getPlayerPhotoUrl(p.name)} number={p.number} size={44} />
              <span className="text-xs text-text-secondary">{p.name}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-tertiary">선수를 선택해주세요</p>
      )}
    </GlassCard>
  );
}
