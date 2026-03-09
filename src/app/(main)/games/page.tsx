"use client";
import { PRESEASON_GAMES, PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import { useRouter } from "next/navigation";
import { getTeamBorderColor } from "@/lib/utils/team-border-color";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Calendar, ChevronLeft, MapPin, RefreshCw, Trophy, Clock } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getMyTeamId } from "@/lib/store/myteam";
import { getTeamById, TEAMS } from "@/lib/constants/teams";
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

      const mapped: GameData[] = (data.games ?? []).map((g: { gameId: string; awayTeamId: number; homeTeamId: number; awayScore: number | null; homeScore: number | null; status: string; time: string; stadium: string; inning?: string; isTop?: boolean; awayStarterName?: string; homeStarterName?: string }) => ({
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
    } catch (e: unknown) {
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
  const scheduledGames = games.filter(g => g.status === "scheduled");

  return (
    <div className="mx-auto max-w-lg">
      <div className="border-b" style={{ borderColor: myTeamId ? getTeamBorderColor(getTeamById(myTeamId)!.colorPrimary) : 'var(--color-border)' }}>
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
                    <CompactGameCard game={g} isPreseason={isPreseason} />
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
                    <CompactGameCard game={g} isPreseason={isPreseason} />
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
                    <CompactGameCard game={g} isPreseason={isPreseason} />
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

/* ===== Empty State Component ===== */
function EmptyGameState({ selectedDate }: { selectedDate: string }) {
  const PRESEASON_START = "2026-03-12";
  const REGULAR_SEASON_START = "2026-03-28";
  const [myTeamId, setMyTeamId] = useState<number | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMyTeamId(getMyTeamId());
    const handler = () => setMyTeamId(getMyTeamId());
    window.addEventListener("team-changed", handler);
    return () => window.removeEventListener("team-changed", handler);
  }, []);

  const now = new Date();
  // KST today
  const kstToday = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const todayStr = kstToday.toISOString().slice(0, 10);

  function daysUntil(targetDate: string): number {
    const target = new Date(targetDate + "T00:00:00+09:00");
    const today = new Date(todayStr + "T00:00:00+09:00");
    return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  }

  const daysToPreseason = daysUntil(PRESEASON_START);
  const daysToRegular = daysUntil(REGULAR_SEASON_START);

  // Find next upcoming preseason date
  const nextPreseasonDate = PRESEASON_DATES.find(d => d > todayStr);
  const upcomingGames = nextPreseasonDate
    ? PRESEASON_GAMES.filter(g => g.date === nextPreseasonDate)
    : [];

  const formatDateLabel = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00+09:00");
    const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
    return `${d.getMonth() + 1}/${d.getDate()}(${weekdays[d.getDay()]})`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="px-5 pb-24 space-y-5"
    >
      {/* 이 날짜는 경기 없음 안내 */}
      <div className="text-center pt-6 pb-2">
        <p className="text-text-tertiary text-sm">이 날은 경기가 없어요</p>
      </div>

      {/* D-day 카운트다운 카드 */}
      <div className="space-y-3">
        {daysToPreseason > 0 && (
          <motion.div
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-2xl bg-bg-secondary border border-border p-4"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Calendar size={16} className="text-accent" />
                <span className="text-sm font-semibold text-text-primary">시범경기 시작</span>
              </div>
              <span className="text-lg font-extrabold text-accent">D-{daysToPreseason}</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(10, 100 - daysToPreseason * 5)}%` }}
                transition={{ duration: 0.8, delay: 0.3 }}
                className="h-full rounded-full bg-accent"
              />
            </div>
            <p className="text-xs text-text-tertiary mt-2">3월 12일 (목) 시작</p>
          </motion.div>
        )}

        {daysToRegular > 0 && (
          <motion.div
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="rounded-2xl bg-bg-secondary border border-border p-4"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Trophy size={16} className="text-yellow-500" />
                <span className="text-sm font-semibold text-text-primary">2026 정규시즌 개막</span>
              </div>
              <span className="text-lg font-extrabold text-yellow-500">D-{daysToRegular}</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(5, 100 - daysToRegular * 2.5)}%` }}
                transition={{ duration: 0.8, delay: 0.4 }}
                className="h-full rounded-full bg-yellow-500"
              />
            </div>
            <p className="text-xs text-text-tertiary mt-2">3월 28일 (토) 개막</p>
          </motion.div>
        )}
      </div>

      {/* 다가오는 시범경기 일정 프리뷰 */}
      {upcomingGames.length > 0 && nextPreseasonDate && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <h3 className="text-sm font-semibold text-text-secondary mb-3 flex items-center gap-1.5">
            <Calendar size={14} />
            다가오는 시범경기 · {formatDateLabel(nextPreseasonDate)}
          </h3>
          <div className="space-y-2">
            {upcomingGames.map((g, i) => {
              const myTeam = myTeamId ? getTeamById(myTeamId) : null;
              const isMyTeamGame = myTeam && (g.away === myTeam.shortName || g.home === myTeam.shortName);
              return (
              <motion.div
                key={`upcoming-${i}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35 + i * 0.05 }}
                className={`rounded-xl px-4 py-3 flex items-center justify-between ${
                  isMyTeamGame
                    ? "border-2 bg-white/5"
                    : "bg-bg-secondary border border-border"
                }`}
                style={isMyTeamGame && myTeam ? { borderColor: `${myTeam.colorLight}60` } : {}}
              >
                <div className="flex items-center gap-3 text-sm">
                  <span className={`font-semibold w-12 text-right ${isMyTeamGame && g.away === myTeam?.shortName ? "text-accent" : "text-text-primary"}`}>{g.away}</span>
                  <span className="text-text-tertiary text-xs">vs</span>
                  <span className={`font-semibold w-12 ${isMyTeamGame && g.home === myTeam?.shortName ? "text-accent" : "text-text-primary"}`}>{g.home}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 text-xs text-text-tertiary">
                    <Clock size={11} />
                    <span>13:00</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-text-tertiary">
                    <MapPin size={12} />
                    <span>{g.venue}</span>
                  </div>
                </div>
              </motion.div>
              );
            })}
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
