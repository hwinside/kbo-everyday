"use client";

import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import { getVisibleBadgeCatalog, RARITY_COLORS, CATEGORY_LABELS } from "@/lib/constants/badges";
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

/** rarity별 배경 글로우 — 강하게 */
const RARITY_GLOW: Record<string, string> = {
  common: "rgba(240,235,220,0.4)",
  rare: "rgba(59,130,246,0.35)",
  epic: "rgba(139,92,246,0.35)",
  legendary: "rgba(245,158,11,0.4)",
};

/** rarity별 보더 — 뚜렷하게 */
const RARITY_BORDER: Record<string, string> = {
  common: "rgba(240,235,220,0.7)",
  rare: "rgba(59,130,246,0.7)",
  epic: "rgba(139,92,246,0.7)",
  legendary: "rgba(245,158,11,0.8)",
};

/** rarity별 box-shadow 글로우 */
const RARITY_SHADOW: Record<string, string> = {
  common: "0 0 8px rgba(240,235,220,0.5)",
  rare: "0 0 10px rgba(59,130,246,0.4)",
  epic: "0 0 10px rgba(139,92,246,0.4)",
  legendary: "0 0 12px rgba(245,158,11,0.5)",
};

export default function BadgesTab({ badges, earnedBadgeIds, onSelectBadge }: BadgesTabProps) {
  const categories = Object.entries(CATEGORY_LABELS);
  const visibleBadges = getVisibleBadgeCatalog(earnedBadgeIds);
  const visibleBadgeIds = new Set(visibleBadges.map(badge => badge.id));

  return (
    <div className="px-5 space-y-4">
      {categories.map(([catId, catLabel]) => {
        const catBadges = visibleBadges.filter(b => b.category === catId);
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
                      earned ? "" : "opacity-60"
                    }`}
                    style={earned ? {
                      background: RARITY_GLOW[badge.rarity],
                      border: `2px solid ${RARITY_BORDER[badge.rarity]}`,
                      boxShadow: RARITY_SHADOW[badge.rarity],
                    } : {
                      border: "2px solid transparent",
                    }}
                  >
                    {/* 획득 체크 표시 */}
                    {earned && (
                      <span
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] text-white font-bold shadow-md"
                        style={{ backgroundColor: "#22c55e" }}
                      >
                        ✓
                      </span>
                    )}
                    <span
                      className="block"
                      style={{
                        fontSize: earned ? "2rem" : "1.5rem",
                        filter: earned ? "none" : "opacity(0.5)",
                        transition: "all 0.2s",
                      }}
                    >
                      {badge.icon}
                    </span>
                    <p
                      className="mt-1 font-bold"
                      style={{
                        fontSize: "10px",
                        color: earned ? RARITY_COLORS[badge.rarity] : "rgba(180,180,180,0.7)",
                        textShadow: earned ? `0 0 6px ${RARITY_COLORS[badge.rarity]}40` : "none",
                        // 한글 배지명은 어절 단위로 줄바꿈한다.
                        // (기본값이면 "크보팬 회장남편" 이 "크보팬 회 / 장남편" 으로 쪼개진다)
                        wordBreak: "keep-all",
                        // 공백 없는 긴 토큰만 예외적으로 강제 줄바꿈 — 카드 밖으로 넘치지 않게
                        overflowWrap: "break-word",
                      }}
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
        {badges.filter(b => visibleBadgeIds.has(b.badge_id)).length}개 획득 / {visibleBadges.length}개 중
      </p>
    </div>
  );
}
