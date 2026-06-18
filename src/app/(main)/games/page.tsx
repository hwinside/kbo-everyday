"use client";
import { PRESEASON_GAMES, PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import { useRouter } from "next/navigation";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { getKSTToday } from "@/lib/utils/date-kst";
import { ChevronLeft, RefreshCw } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getMyTeamId } from "@/lib/store/myteam";
import DateSelector from "@/components/game/DateSelector";
import CompactGameCard from "@/components/game/CompactGameCard";
import EmptyGameState from "@/components/game/EmptyGameState";

interface GameData {
  id: string;
  awayTeamId: number;
  homeTeamId: number;
  awayScore: number | null;
  homeScore: number | null;
  status: "scheduled" | "live" | "final" | "cancelled";
  time: string;
  stadium: string;
  inning?: string;
  awayStarter?: string;
  homeStarter?: string;
  broadcastChannels?: string[];
}

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } };

function formatDate(dateStr: string): string {
  return dateStr.replace(/-/g, "");
}

function buildPreseasonFallback(date: string): GameData[] {
  const dateStr = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
  const TEAM_ID: Record<string, number> = { LG:1, 두산:2, KT:3, SSG:4, NC:5, KIA:6, 롯데:7, 삼성:8, 한화:9, 키움:10 };
  return PRESEASON_GAMES
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
}

export default function GamesPage() {
  const today = getKSTToday();
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(today);
  const [games, setGames] = useState<GameData[]>([]);
  const isPreseason = PRESEASON_DATES.includes(selectedDate);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myTeamId, setMyTeamId] = useState<number | null>(null);

  useEffect(() => {
    setMyTeamId(getMyTeamId());
  }, []);

  async function loadGames(date: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/games?date=${formatDate(date)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const mapped: GameData[] = (data.games ?? []).map((g: { gameId: string; awayTeamId: number; homeTeamId: number; awayScore: number | null; homeScore: number | null; status: "scheduled" | "live" | "final" | "cancelled"; time: string; stadium: string; inning?: string; isTop?: boolean; awayStarterName?: string; homeStarterName?: string; broadcastChannels?: string[] }) => ({
        id: g.gameId,
        awayTeamId: g.awayTeamId,
        homeTeamId: g.homeTeamId,
        awayScore: g.awayScore,
        homeScore: g.homeScore,
        status: g.status,
        time: g.time,
        stadium: g.stadium,
        inning: g.status === "live" ? `${g.inning}회${g.isTop ? "초" : "말"}` : undefined,
        awayStarter: g.awayStarterName,
        homeStarter: g.homeStarterName,
        broadcastChannels: g.broadcastChannels,
      }));

      if (mapped.length === 0) {
        setGames(buildPreseasonFallback(date));
      } else {
        setGames(mapped);
      }
    } catch (e: unknown) {
      const preGames = buildPreseasonFallback(date);
      if (preGames.length > 0) {
        setGames(preGames);
        setError(null);
      } else {
        setError((e as Error).message);
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
  const cancelledGames = games.filter(g => g.status === "cancelled");
  const scheduledGames = games.filter(g => g.status === "scheduled");

  return (
    <div className="mx-auto max-w-lg">
      <div className="border-b" style={{ borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)' }}>
        <div className="flex items-center gap-3 px-5 py-3">
          <button onClick={() => router.back()} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight flex-1">경기</h1>
          <button
            onClick={() => loadGames(selectedDate)}
            className="p-2 rounded-full text-text-tertiary hover:bg-bg-tertiary transition-colors"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
          <HeaderProfileLink />
        </div>
      </div>

      <div className="mt-1">
        <DateSelector selectedDate={selectedDate} onDateChange={setSelectedDate} />
      </div>

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
        <EmptyGameState selectedDate={selectedDate} />
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
                    <CompactGameCard game={g} isPreseason={isPreseason} myTeamId={myTeamId} />
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
                    <CompactGameCard game={g} isPreseason={isPreseason} myTeamId={myTeamId} />
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {cancelledGames.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-text-tertiary mb-2">취소</h2>
              <div className="space-y-2">
                {cancelledGames.map(g => (
                  <motion.div key={g.id} variants={item}>
                    <CompactGameCard game={g} isPreseason={isPreseason} myTeamId={myTeamId} />
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
                    <CompactGameCard game={g} isPreseason={isPreseason} myTeamId={myTeamId} />
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
