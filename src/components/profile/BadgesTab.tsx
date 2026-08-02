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
              좁은 화면은 3열, 390px 부터 4열.

              2026-08-03 Production 사고(`크보/팬 전속/가수`, `파운/더`)의 실효 수정이다.
              문제는 글자 크기가 아니라 **칸 폭**이었다. 침입 포인트는 최장 어절
              `회장남편`(4자 = 10px 기준 40px)이 칸 텍스트 폭에 들어가느냐다.

              실측(Chromium / 텍스트 영역 폭, 40px 대비 여유):
                320px 3열 51.3px (+11.3)   360px 3열 64.7px (+24.7)
                375px 3열 69.7px (+29.7)   390px 4열 48.0px (+8.0)
                430px 4열 58.0px (+18.0)   512px 4열 78.5px (+38.5)

              4열 전환을 360px 로 두면 360px 여유가 **0.5px** 라 폰트·자간이 조금만
              달라져도 다시 쪼개진다. 그래서 390px 로 올려 최소 여유 8px 를 확보했다.
            */}
            <div className="grid grid-cols-3 min-[390px]:grid-cols-4 gap-3">
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
                        // 글자 크기는 10px 고정이다(축소 금지).
                        //
                        // 이전 시도인 `clamp(8px, 2.6cqw, 10px)` 는 반응형이 아니었다.
                        // cqw 는 카드 폭의 1% 라 2.6cqw = 1.3~2.6px 에 불과해,
                        // 320px 부터 512px 까지 **전 구간이 clamp 하한 8px 에 고정**됐다(실측).
                        // 결과적으로 데스크톱까지 모든 배지명을 20% 축소하는 가독성 회귀였다.
                        // 사고의 진짜 원인은 글자 크기가 아니라 칸 폭이므로(위 grid 주석),
                        // 여기서 줄이지 않는다.
                        fontSize: "10px",
                        color: earned ? RARITY_COLORS[badge.rarity] : "rgba(180,180,180,0.7)",
                        textShadow: earned ? `0 0 6px ${RARITY_COLORS[badge.rarity]}40` : "none",
                        // 한글 배지명은 어절 단위로만 줄바꿈한다.
                        // (기본값이면 "크보팬 회장남편" 이 "크보팬 회 / 장남편" 으로 쪼개진다)
                        wordBreak: "keep-all",
                        // 공백 없는 긴 토큰이 칸을 넘어가는 경우의 최종 안전망.
                        // ⚠️ 이건 이번 사고의 수정이 아니다 — `anywhere`/`break-word` 어느 쪽이든
                        // 게이트 결과가 같아 단독 효과가 없음을 확인했다. 기존 값을 유지한다.
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
