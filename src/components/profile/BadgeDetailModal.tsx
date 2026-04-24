"use client";

import { motion, AnimatePresence } from "framer-motion";
import { RARITY_COLORS } from "@/lib/constants/badges";
import type { BadgeDefinition } from "@/lib/constants/badges";

interface BadgeDetailModalProps {
  selectedBadge: BadgeDefinition | null;
  earnedBadgeIds: Set<string>;
  onClose: () => void;
}

export default function BadgeDetailModal({ selectedBadge, earnedBadgeIds, onClose }: BadgeDetailModalProps) {
  return (
    <AnimatePresence>
      {selectedBadge && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/60" />
          <motion.div
            className="relative bg-bg-secondary rounded-2xl border border-border p-5 text-center max-w-[280px] w-full"
            initial={{ scale: 0.8, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.8, y: 20 }}
            onClick={e => e.stopPropagation()}
          >
            <span className="text-5xl">{selectedBadge.icon}</span>
            <h3 className="text-lg font-bold text-text-primary mt-3">{selectedBadge.name}</h3>
            <p className="text-sm text-text-secondary mt-2">{selectedBadge.description}</p>
            <div className="mt-3">
              <span
                className="text-xs font-bold px-3 py-1 rounded-full"
                style={{ backgroundColor: RARITY_COLORS[selectedBadge.rarity] + "20", color: RARITY_COLORS[selectedBadge.rarity] }}
              >
                {selectedBadge.rarity === "common" ? "일반" : selectedBadge.rarity === "rare" ? "레어" : selectedBadge.rarity === "epic" ? "에픽" : "전설"}
              </span>
            </div>
            {earnedBadgeIds.has(selectedBadge.id)
              ? <p className="text-xs text-green-400 mt-3">✅ 획득 완료!</p>
              : <p className="text-xs text-text-tertiary mt-3">🔒 아직 미획득</p>
            }
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
