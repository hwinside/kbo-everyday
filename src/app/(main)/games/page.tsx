"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import DateSelector from "@/components/game/DateSelector";
import CompactGameCard from "@/components/game/CompactGameCard";

// Mock 경기 데이터 (날짜별)
const MOCK_GAMES = [
  { id: 1, awayTeamId: 2, homeTeamId: 1, awayScore: 3, homeScore: 5, status: "final" as const, time: "14:00", stadium: "잠실" },
  { id: 2, awayTeamId: 6, homeTeamId: 7, awayScore: 7, homeScore: 3, status: "final" as const, time: "14:00", stadium: "사직" },
  { id: 3, awayTeamId: 4, homeTeamId: 3, awayScore: 2, homeScore: 4, status: "live" as const, inning: "7회초", time: "17:00", stadium: "수원" },
  { id: 4, awayTeamId: 8, homeTeamId: 5, awayScore: 1, homeScore: 1, status: "live" as const, inning: "5회말", time: "17:00", stadium: "창원" },
  { id: 5, awayTeamId: 9, homeTeamId: 10, awayScore: 0, homeScore: 0, status: "scheduled" as const, time: "18:30", stadium: "고척" },
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

export default function GamesPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(today);

  const liveGames = MOCK_GAMES.filter(g => g.status === "live");
  const finalGames = MOCK_GAMES.filter(g => g.status === "final");
  const scheduledGames = MOCK_GAMES.filter(g => g.status === "scheduled");

  return (
    <div className="mx-auto max-w-lg pt-safe">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <Link href="/" className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </Link>
        <h1 className="text-xl font-bold text-text-primary">경기</h1>
      </div>

      {/* Date selector */}
      <DateSelector selectedDate={selectedDate} onDateChange={setSelectedDate} />

      {/* Games list */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="px-5 py-4 space-y-6"
      >
        {/* LIVE */}
        {liveGames.length > 0 && (
          <motion.section variants={item}>
            <div className="flex items-center gap-2 mb-3">
              <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              <h2 className="text-sm font-bold text-red-400">LIVE</h2>
            </div>
            <div className="space-y-3">
              {liveGames.map(game => (
                <CompactGameCard key={game.id} game={game} />
              ))}
            </div>
          </motion.section>
        )}

        {/* Final */}
        {finalGames.length > 0 && (
          <motion.section variants={item}>
            <h2 className="text-sm font-bold text-text-tertiary mb-3">종료</h2>
            <div className="space-y-3">
              {finalGames.map(game => (
                <CompactGameCard key={game.id} game={game} />
              ))}
            </div>
          </motion.section>
        )}

        {/* Scheduled */}
        {scheduledGames.length > 0 && (
          <motion.section variants={item}>
            <h2 className="text-sm font-bold text-text-tertiary mb-3">예정</h2>
            <div className="space-y-3">
              {scheduledGames.map(game => (
                <CompactGameCard key={game.id} game={game} />
              ))}
            </div>
          </motion.section>
        )}

        {MOCK_GAMES.length === 0 && (
          <div className="py-20 text-center text-text-tertiary">
            경기가 없는 날입니다
          </div>
        )}
      </motion.div>
    </div>
  );
}
