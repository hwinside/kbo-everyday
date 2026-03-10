"use client";

import { motion, AnimatePresence } from "framer-motion";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import type { FavoritePlayer } from "@/lib/store/favorites";

interface PlayerPickerSheetProps {
  open: boolean;
  onClose: () => void;
  players: FavoritePlayer[];
  onSelect: (playerId: string) => void;
}

export default function PlayerPickerSheet({ open, onClose, players, onSelect }: PlayerPickerSheetProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-bg-secondary overflow-y-auto"
            style={{ maxHeight: "92dvh" }}
          >
            <div className="flex justify-center pt-3">
              <div className="h-1 w-10 rounded-full bg-text-tertiary" />
            </div>
            <div className="flex flex-col h-full">
              <div className="sticky top-0 bg-bg-secondary px-5 pt-3 pb-2 z-10">
                <h3 className="text-lg font-bold text-text-primary">어떤 선수 게시판에 쓸까요?</h3>
              </div>
              <div className="px-5 pb-24 space-y-2 overflow-y-auto flex-1">
                {players.map((player) => (
                  <button
                    key={player.playerId}
                    onClick={() => onSelect(player.playerId)}
                    className="w-full flex items-center gap-3 text-left rounded-xl bg-bg-tertiary px-4 py-3 text-base font-semibold text-text-primary hover:bg-bg-glass active:scale-[0.98] transition-all"
                  >
                    <PlayerAvatar
                      name={player.name}
                      teamId={player.teamId}
                      photoUrl={getPlayerPhotoUrl(player.name, player.playerId)}
                      size={36}
                    />
                    {player.name}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
