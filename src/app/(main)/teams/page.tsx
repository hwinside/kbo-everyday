"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Link from "next/link";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import GlassCard from "@/components/ui/GlassCard";
import TeamLogo from "@/components/ui/TeamLogo";
import { TEAMS } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamById } from "@/lib/constants/teams";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

const item = {
  hidden: { opacity: 0, scale: 0.95 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.25 } },
};

export default function TeamsPage() {
  const router = useRouter();
  const { profile } = useAuth();

  // Deep-link to my team's hub if set
  useEffect(() => {
    if (profile?.team_id) {
      const myTeam = getTeamById(profile.team_id);
      if (myTeam) {
        router.replace(`/teams/${myTeam.slug}`);
      }
    }
  }, [profile, router]);

  return (
    <div className="mx-auto max-w-lg px-5">
      <div className="sticky top-0 z-30 -mx-5 border-b border-border bg-bg-primary px-5" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <header className="min-h-[44px] flex items-center justify-between gap-3">
        <h1 className="truncate text-lg font-bold text-text-primary">구단 선택</h1>
        <HeaderProfileLink />
      </header>
      </div>

      {/* 헤더에서 내린 서브문구 */}
      <p className="px-1 pt-3 text-sm text-text-tertiary">팀 허브로 이동합니다</p>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="grid grid-cols-2 gap-4 pb-5"
      >
        {TEAMS.map((team) => (
          <motion.div key={team.id} variants={item}>
            <Link href={`/teams/${team.slug}`}>
              <GlassCard
                pressable
                className="flex flex-col items-center justify-center gap-4 p-6"
              >
                <TeamLogo team={team} size={64} />
                <span className="text-base font-semibold text-text-primary">
                  {team.name}
                </span>
              </GlassCard>
            </Link>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
