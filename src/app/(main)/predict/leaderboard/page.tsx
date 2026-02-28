"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import Leaderboard from "@/components/prediction/Leaderboard";
import { MOCK_LEADERBOARD } from "@/lib/constants/predictions";

type TabType = "all" | "team" | "weekly";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

export default function LeaderboardPage() {
  const [activeTab, setActiveTab] = useState<TabType>("all");

  const tabs: { key: TabType; label: string }[] = [
    { key: "all", label: "전체" },
    { key: "team", label: "팀별" },
    { key: "weekly", label: "주간" },
  ];

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-lg px-4 pt-safe"
    >
      {/* Header */}
      <motion.header variants={item} className="flex items-center gap-2 py-4">
        <Link href="/predict" className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </Link>
        <h1 className="text-xl font-bold text-text-primary">예측왕 랭킹</h1>
      </motion.header>

      {/* Tabs */}
      <motion.div variants={item} className="mb-4 flex gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-all ${
              activeTab === tab.key
                ? "bg-accent text-white"
                : "bg-bg-tertiary text-text-secondary hover:text-text-primary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </motion.div>

      {/* Leaderboard */}
      <motion.div variants={item} className="pb-8">
        <Leaderboard entries={MOCK_LEADERBOARD} />
      </motion.div>
    </motion.div>
  );
}
