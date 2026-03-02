"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Check, Star } from "lucide-react";
import Image from "next/image";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl, PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { getTeamById, TEAMS } from "@/lib/constants/teams";
import type { FavoritePlayer } from "@/lib/store/favorites";

// 전체 선수 목록 (PLAYER_PHOTO_MAP 기반, 146명)
const ALL_PLAYER_LIST = Object.entries(PLAYER_PHOTO_MAP).map(([name, kboId]) => ({
  id: kboId,
  name,
}));

interface PlayerSelectModalProps {
  isOpen: boolean;
  teamId: number;
  onComplete: (players: FavoritePlayer[]) => void;
  onSkip: () => void;
}

export default function PlayerSelectModal({ isOpen, teamId, onComplete, onSkip }: PlayerSelectModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const team = getTeamById(teamId);
  const [search, setSearch] = useState("");
  const players = ALL_PLAYER_LIST.filter(p => !search || p.name.includes(search));

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 3) {
        next.add(id);
      }
      return next;
    });
  };

  const handleComplete = () => {
    const favs: FavoritePlayer[] = players
      .filter(p => selected.has(p.id))
      .map(p => ({ playerId: p.id, name: p.name, teamId, position: "", number: 0 }));
    onComplete(favs);
  };

  if (!isOpen || !team) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-bg-primary"
    >
      <div className="w-full max-w-lg px-6">
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="text-center mb-6"
        >
          <div className="flex items-center justify-center gap-2 mb-2">
            <Image src={team.logoPath} alt="" width={32} height={32} unoptimized className="object-contain" />
            <h1 className="text-xl font-bold text-text-primary">최애 선수를 골라주세요</h1>
          </div>
          <p className="text-sm text-text-tertiary">최대 3명 · 선택한 선수 중심으로 피드가 구성됩니다</p>
          <div className="flex justify-center gap-1 mt-3">
            {[0, 1, 2].map(i => (
              <Star
                key={i}
                size={20}
                fill={i < selected.size ? team.colorLight : "none"}
                className={i < selected.size ? "" : "text-text-tertiary"}
                style={i < selected.size ? { color: team.colorLight } : {}}
              />
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="space-y-2 max-h-[50vh] overflow-y-auto"
        >
          {players.map((player, i) => {
            const isSelected = selected.has(player.id);
            return (
              <motion.button
                key={player.id}
                initial={{ x: -20, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ delay: 0.3 + i * 0.05 }}
                onClick={() => toggle(player.id)}
                className="w-full flex items-center gap-3 p-3 rounded-2xl transition-all"
                style={{
                  background: isSelected ? `${team.colorPrimary}20` : "rgba(255,255,255,0.03)",
                  border: `2px solid ${isSelected ? team.colorLight : "transparent"}`,
                }}
              >
                <PlayerAvatar
                  name={player.name}
                  teamId={teamId}
                  photoUrl={getPlayerPhotoUrl(player.name)}
                  number={0}
                  size={48}
                />
                <div className="flex-1 text-left">
                  <p className="text-sm font-bold text-text-primary">{player.name}</p>
                  <p className="text-xs text-text-tertiary"></p>
                </div>
                {isSelected ? (
                  <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ backgroundColor: team.colorLight }}>
                    <Check size={16} className="text-white" />
                  </div>
                ) : (
                  <div className="w-7 h-7 rounded-full border-2 border-text-tertiary/30" />
                )}
              </motion.button>
            );
          })}
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="mt-6 space-y-2"
        >
          <button
            onClick={handleComplete}
            disabled={selected.size === 0}
            className="w-full py-3 rounded-xl text-sm font-bold text-white transition-opacity disabled:opacity-30"
            style={{ backgroundColor: team.colorLight }}
          >
            {selected.size}명 선택 완료
          </button>
          <button
            onClick={onSkip}
            className="w-full py-2 text-sm text-text-tertiary"
          >
            나중에 할게요
          </button>
        </motion.div>
      </div>
    </motion.div>
  );
}
