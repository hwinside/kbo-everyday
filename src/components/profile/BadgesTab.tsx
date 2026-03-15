"use client";

import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import { BADGES, RARITY_COLORS, CATEGORY_LABELS } from "@/lib/constants/badges";
import type { BadgeDefinition } from "@/lib/constants/badges";
import { getBadgeInfo } from "@/lib/utils/badges";

interface UserBadge {
  badge_id: string;
  earned_at: string;
}

interface BadgesTabProps {
  badges: UserBadge[];
  earnedBadgeIds: Set<string>;
  onSelectBadge: (badge: BadgeDefinition) => void;
}

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
                    className={`text-center p-2 rounded-xl transition-all cursor-pointer ${
                      earned ? "bg-black/5 dark:bg-white/5" : "opacity-30"
                    }`}
                  >
                    <span className={`text-2xl ${earned ? "" : "grayscale"}`}>{badge.icon}</span>
                    <p className="text-[10px] mt-1 font-medium" style={{ color: earned ? RARITY_COLORS[badge.rarity] : "#666" }}>
                      {badge.name}
                    </p>
                  </motion.div>
                );
              })}
            </div>
          </GlassCard>
        );
      })}
      {/* 동적 배지 (선수/팀 덕후) */}
      {badges.filter(b => b.badge_id.startsWith("fan-")).length > 0 && (
        <GlassCard className="p-4">
          <h3 className="text-sm font-bold text-text-primary mb-3">⚾ 나의 덕질 배지</h3>
          <div className="grid grid-cols-4 gap-3">
            {badges.filter(b => b.badge_id.startsWith("fan-")).map(b => {
              const info = getBadgeInfo(b.badge_id);
              if (!info) return null;
              return (
                <motion.div key={b.badge_id} className="text-center p-2 rounded-xl bg-black/5 dark:bg-white/5">
                  <span className="text-2xl">{info.icon}</span>
                  <p className="text-[10px] mt-1 font-medium" style={{ color: RARITY_COLORS[info.rarity] }}>
                    {info.name}
                  </p>
                </motion.div>
              );
            })}
          </div>
        </GlassCard>
      )}

      <p className="text-center text-xs text-text-tertiary">
        {badges.length}개 획득 / {BADGES.length}개 중
      </p>
    </div>
  );
}
