"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Users, Calendar, BarChart3, Newspaper, Video, MapPin, Swords, MessageSquare } from "lucide-react";
import type { TeamData } from "@/lib/constants/teams";
import { STADIUMS } from "@/lib/constants/stadiums";

interface TeamMenuProps {
  team: TeamData;
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const item = {
  hidden: { opacity: 0, scale: 0.9 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.2 } },
};

export default function TeamMenu({ team }: TeamMenuProps) {
  const stadium = STADIUMS.find((s) => s.teamIds.includes(team.id));

  const menuItems = [
    { label: "팀 기록", icon: BarChart3, href: `/teams/${team.slug}/records` },
    { label: "선수 기록", icon: Users, href: `/teams/${team.slug}/player-records` },
    { label: "일정", icon: Calendar, href: `/teams/${team.slug}/schedule` },
    { label: "뉴스", icon: Newspaper, href: `/teams/${team.slug}/news` },
    { label: "공식영상", icon: Video, href: `/teams/${team.slug}/videos` },
    { label: "구장", icon: MapPin, href: stadium ? `/community/stadiums/${stadium.id}` : "/community/stadiums" },
    { label: "상대전적", icon: Swords, href: `/teams/${team.slug}/matchups` },
    { label: "게시판", icon: MessageSquare, href: `/community/teams/${team.slug}` },
  ];

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="grid grid-cols-4 gap-3 px-5 py-4"
    >
      {menuItems.map((mi) => (
        <motion.div key={mi.label} variants={item}>
          <Link
            href={mi.href}
            className="flex flex-col items-center gap-1.5 rounded-2xl bg-bg-glass/60 py-3 px-2 transition-colors hover:bg-bg-tertiary/50 active:scale-95"
          >
            <mi.icon size={22} className="text-text-secondary" />
            <span className="text-xs font-medium text-text-primary text-center leading-tight">{mi.label}</span>
          </Link>
        </motion.div>
      ))}
    </motion.div>
  );
}
