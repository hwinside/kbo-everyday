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
            {/*
              좀은 화면은 3열. 320px × 4열은 칸당 텍스트 폭이 ~30px 밖에 안 나와
              `전속가수`·`회장남편` 같은 4자 어절이 글자를 아무리 줄여도(8px 하한)
              들어가지 않는다. 3열로 바꾸면 ~58px 로 늘어 어절이 보존된다.
              (2026-08-03 Production 사고 — `크보/팬 전속/가수`, `파운/더`)
            */}
            <div className="grid grid-cols-3 min-[360px]:grid-cols-4 gap-3">
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
                    // containerType: 배지명 font-size 가 카드 폭(cqw)에 비례하도록 컨테이너 기준점을 여기 둔다.
                    style={earned ? {
                      containerType: "inline-size",
                      background: RARITY_GLOW[badge.rarity],
                      border: `2px solid ${RARITY_BORDER[badge.rarity]}`,
                      boxShadow: RARITY_SHADOW[badge.rarity],
                    } : {
                      containerType: "inline-size",
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
                        // ★ 이번 hotfix 의 실효 변경.
                        // 320px 에서 4열 카드의 텍스트 폭은 ~37px 라 10px 글자로는 3.7자밖에
                        // 못 들어간다. 그래서 `전속가수`(4자)·`회장남편`·`수다쟁이` 같은
                        // 4자 어절이 반드시 쪼개졌다(하린아빠 Production 실측).
                        // wordBreak: keep-all 은 "한 줄에 들어갈 수 있을 때" 만 어절을 지키므로,
                        // 들어갈 공간 자체를 만들어줘야 한다 → 칸 폭(cqw)에 비례해 축소.
                        // 큰 화면에선 기존 10px 유지(상한), 가독성 하한 8px.
                        fontSize: "clamp(8px, 2.6cqw, 10px)",
                        color: earned ? RARITY_COLORS[badge.rarity] : "rgba(180,180,180,0.7)",
                        textShadow: earned ? `0 0 6px ${RARITY_COLORS[badge.rarity]}40` : "none",
                        // 한글 배지명은 어절 단위로만 줄바꿈한다.
                        // (기본값이면 "크보팬 회장남편" 이 "크보팬 회 / 장남편" 으로 쪼개진다)
                        wordBreak: "keep-all",
                        // 공백 없는 긴 토큰이 칸을 넘어가는 경우의 최종 안전망.
                        // ⚠️ 이것만으로는 320px 어절 분리가 해결되지 않는다 — 실효 수정은
                        // 아래 fontSize clamp 다(이 줄을 break-word 로 되돌려도 게이트는 GREEN 이었다).
                        overflowWrap: "anywhere",
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
