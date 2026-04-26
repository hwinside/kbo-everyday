"use client";

import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import { BADGES, ACTIVE_BADGE_IDS, RARITY_COLORS, CATEGORY_LABELS } from "@/lib/constants/badges";
import type { BadgeDefinition } from "@/lib/constants/badges";

interface UserBadge {
  badge_id: string;
  earned_at: string;
}

interface BadgesTabProps {
  badges: UserBadge[];
  earnedBadgeIds: Set<string>;
  onSelectBadge: (badge: BadgeDefinition) => void;
}

/** rarity별 글로우 색상 (earned badge 배경 하이라이트) */
const RARITY_GLOW: Record<string, string> = {
  common: "rgba(220,215,200,0.3)",
  rare: "rgba(59,130,246,0.3)",
  epic: "rgba(139,92,246,0.3)",
  legendary: "rgba(245,158,11,0.35)",
};

/** rarity별 보더 색상 */
const RARITY_BORDER: Record<string, string> = {
  common: "rgba(230,225,210,0.5)",
  rare: "rgba(59,130,246,0.5)",
  epic: "rgba(139,92,246,0.5)",
  legendary: "rgba(245,158,11,0.6)",
};

export default function BadgesTab({ badges, earnedBadgeIds, onSelectBadge }: BadgesTabProps) {
  const categories = Object.entries(CATEGORY_LABELS);

  return (
    <div className="px-5 space-y-4">
      {categories.map(([catId, catLabel]) => {
        const catBadges = BADGES.filter(b => b.category === catId);
        if (catBadges.length === 0) return null;
        return (
          <GlassCard key={catId} className="p-4">
            <h3 className="text-sm font-bold text-text-primary mb-3">{catLabel}</h3>
            <div className="grid grid-cols-4 gap-3">
              {catBadges.map(badge => {
                const earned = earnedBadgeIds.has(badge.id);
                return (
                  <motion.div
                    key={badge.id}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => onSelectBadge(badge)}
                    className={`text-center p-2 rounded-xl transition-all cursor-pointer relative ${
                      earned ? "" : "opacity-40"
                    }`}
                    style={earned ? {
                      background: RARITY_GLOW[badge.rarity],
                      border: `1.5px solid ${RARITY_BORDER[badge.rarity]}`,
                    } : {
                      border: "1.5px solid transparent",
                    }}
                  >
                    {/* 획득 체크 표시 */}
                    {earned && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center text-[9px] text-white font-bold shadow-sm">
                        ✓
                      </span>
                    )}
                    <span className={`text-2xl block ${earned ? "drop-shadow-sm" : "grayscale opacity-60"}`}>
                      {badge.icon}
                    </span>
                    <p
                      className={`text-[10px] mt-1 font-semibold ${earned ? "" : "text-text-tertiary/50"}`}
                      style={earned ? { color: RARITY_COLORS[badge.rarity] } : undefined}
                    >
                      {badge.name}
                    </p>
                  </motion.div>
                );
              })}
            </div>
          </GlassCard>
        );
      })}

      <p className="text-center text-xs text-text-tertiary">
        {badges.filter(b => ACTIVE_BADGE_IDS.has(b.badge_id)).length}개 획득 / {BADGES.length}개 중
      </p>
    </div>
  );
}
