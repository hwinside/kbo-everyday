"use client";
import { PRESEASON_GAMES } from "@/lib/constants/preseason-schedule";
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
      // KBO API 결과 없으면 시범경기 데이터 fallback
      if (mapped.length === 0) {
        const dateStr = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
        const TEAM_ID: Record<string, number> = { LG:1, 두산:2, KT:3, SSG:4, NC:5, KIA:6, 롯데:7, 삼성:8, 한화:9, 키움:10 };
        const preGames = PRESEASON_GAMES
          .filter(g => g.date === dateStr)
          .map((g, i) => ({
            id: `pre-${dateStr}-${i}`,
            awayTeamId: TEAM_ID[g.away] ?? 0,
            homeTeamId: TEAM_ID[g.home] ?? 0,
            awayScore: 0,
            homeScore: 0,
            status: "scheduled" as const,
            time: "13:00",
            stadium: g.venue,
            inning: undefined,
            awayStarter: "",
            homeStarter: "",
          }));
        setGames(preGames);
      } else {
        setGames(mapped);
      }
    } catch (e: any) {
      // 에러 시에도 시범경기 fallback
      const dateStr = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
      const TEAM_ID: Record<string, number> = { LG:1, 두산:2, KT:3, SSG:4, NC:5, KIA:6, 롯데:7, 삼성:8, 한화:9, 키움:10 };
      const preGames = PRESEASON_GAMES
        .filter(g => g.date === dateStr)
        .map((g, i) => ({
          id: `pre-${dateStr}-${i}`,
          awayTeamId: TEAM_ID[g.away] ?? 0,
          homeTeamId: TEAM_ID[g.home] ?? 0,
          awayScore: 0,
          homeScore: 0,
          status: "scheduled" as const,
          time: "13:00",
          stadium: g.venue,
          inning: undefined,
          awayStarter: "",
          homeStarter: "",
        }));
      if (preGames.length > 0) {
        setGames(preGames);
        setError(null);
      } else {
        setError(e.message);
        setGames([]);
      }
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
      <div className="flex items-center gap-3 px-5 py-3">
        <button onClick={() => router.back()} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-3xl font-extrabold text-text-primary tracking-tight">경기</h1>
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
