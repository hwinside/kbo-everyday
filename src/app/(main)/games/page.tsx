"use client";
import { useRouter } from "next/navigation";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import DateSelector from "@/components/game/DateSelector";
import CompactGameCard from "@/components/game/CompactGameCard";

interface GameData {
  id: string;
  awayTeamId: number;
  homeTeamId: number;
  awayScore: number | null;
  homeScore: number | null;
  status: "scheduled" | "live" | "final";
  time: string;
  stadium: string;
  inning?: string;
  awayStarter?: string;
  homeStarter?: string;
}

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } };

function formatDate(dateStr: string): string {
  // "2025-05-01" → "20250501"
  return dateStr.replace(/-/g, "");
}

export default function GamesPage() {
  const today = new Date().toISOString().slice(0, 10);
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(today);
  const [games, setGames] = useState<GameData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadGames(date: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/games?date=${formatDate(date)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const mapped: GameData[] = (data.games ?? []).map((g: any) => ({
        id: g.gameId,
        awayTeamId: g.awayTeamId,
        homeTeamId: g.homeTeamId,
        awayScore: g.awayScore,
        homeScore: g.homeScore,
        status: g.status === "cancelled" ? "final" as const : g.status,
        time: g.time,
        stadium: g.stadium,
        inning: g.status === "live" ? `${g.inning}회${g.isTop ? "초" : "말"}` : undefined,
        awayStarter: g.awayStarterName,
        homeStarter: g.homeStarterName,
      }));
      setGames(mapped);
    } catch (e: any) {
      setError(e.message);
      setGames([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadGames(selectedDate);
  }, [selectedDate]);

  // 라이브 경기 있으면 30초마다 자동 새로고침
  useEffect(() => {
    const hasLive = games.some(g => g.status === "live");
    if (!hasLive) return;
    const interval = setInterval(() => loadGames(selectedDate), 30000);
    return () => clearInterval(interval);
  }, [games, selectedDate]);

  const liveGames = games.filter(g => g.status === "live");
  const finalGames = games.filter(g => g.status === "final");
  const scheduledGames = games.filter(g => g.status === "scheduled");

  return (
    <div className="mx-auto max-w-lg">
      <div className="flex items-center gap-3 px-5 py-2">
        <button onClick={() => router.back()} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-xl font-bold text-text-primary">경기</h1>
        <button
          onClick={() => loadGames(selectedDate)}
          className="ml-auto p-2 rounded-full text-text-tertiary hover:bg-bg-tertiary transition-colors"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <DateSelector selectedDate={selectedDate} onDateChange={setSelectedDate} />

      {loading && games.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={24} className="animate-spin text-text-tertiary" />
        </div>
      ) : error ? (
        <div className="px-5 py-20 text-center text-text-tertiary text-sm">
          데이터를 불러올 수 없습니다
          <button onClick={() => loadGames(selectedDate)} className="block mx-auto mt-2 text-accent text-xs">다시 시도</button>
        </div>
      ) : games.length === 0 ? (
        <div className="px-5 py-20 text-center text-text-tertiary text-sm">
          경기가 없습니다
        </div>
      ) : (
        <motion.div variants={container} initial="hidden" animate="show" className="px-5 pb-24 space-y-6">
          {liveGames.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-red-400 mb-2 flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> LIVE
              </h2>
              <div className="space-y-2">
                {liveGames.map(g => (
                  <motion.div key={g.id} variants={item}>
                    <CompactGameCard game={g} />
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {finalGames.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-tertiary mb-2">종료</h2>
              <div className="space-y-2">
                {finalGames.map(g => (
                  <motion.div key={g.id} variants={item}>
                    <CompactGameCard game={g} />
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {scheduledGames.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-tertiary mb-2">예정</h2>
              <div className="space-y-2">
                {scheduledGames.map(g => (
                  <motion.div key={g.id} variants={item}>
                    <CompactGameCard game={g} />
                  </motion.div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}
