"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamLogo from "@/components/ui/TeamLogo";
import { TEAMS } from "@/lib/constants/teams";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

const item = {
  hidden: { opacity: 0, scale: 0.95 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.25 } },
};

export default function TeamsPage() {
  return (
    <div className="mx-auto max-w-lg px-5">
      <header className="flex items-center gap-4 py-5">
        <Link href="/" className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </Link>
        <h1 className="text-xl font-bold text-text-primary">구단 게시판</h1>
      </header>

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
                <span className="text-base text-text-tertiary">게시판</span>
              </GlassCard>
            </Link>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
