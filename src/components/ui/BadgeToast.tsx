"use client";

import { motion, AnimatePresence } from "framer-motion";
import { BADGE_MAP, RARITY_COLORS } from "@/lib/constants/badges";

interface BadgeToastProps {
  badgeIds: string[];
  onDone: () => void;
}

export default function BadgeToast({ badgeIds, onDone }: BadgeToastProps) {
  if (badgeIds.length === 0) return null;

  return (
    <AnimatePresence onExitComplete={onDone}>
      <motion.div
        className="fixed top-20 left-1/2 z-[60] -translate-x-1/2"
        initial={{ opacity: 0, y: -30, scale: 0.8 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.9 }}
        transition={{ type: "spring", damping: 20 }}
      >
        <div className="bg-bg-secondary border border-amber-500/30 rounded-2xl px-5 py-4 shadow-2xl shadow-amber-500/10 min-w-[240px]">
          <p className="text-xs text-amber-400 font-bold text-center mb-2">🏅 새 배지 획득!</p>
          <div className="flex items-center justify-center gap-3">
            {badgeIds.map(id => {
              const badge = BADGE_MAP[id];
              if (!badge) return null;
              return (
                <div key={id} className="text-center">
                  <span className="text-3xl">{badge.icon}</span>
                  <p className="text-xs font-bold mt-1" style={{ color: RARITY_COLORS[badge.rarity] }}>
                    {badge.name}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
