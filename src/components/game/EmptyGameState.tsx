"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Calendar, MapPin, Clock, Trophy } from "lucide-react";
import { PRESEASON_GAMES, PRESEASON_DATES } from "@/lib/constants/preseason-schedule";
import { getMyTeamId } from "@/lib/store/myteam";
import { getTeamById } from "@/lib/constants/teams";
import { getKSTToday, daysFromKSTToday } from "@/lib/utils/date-kst";

export default function EmptyGameState({ selectedDate }: { selectedDate: string }) {
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

  const todayStr = getKSTToday();

  const daysToPreseason = daysFromKSTToday(PRESEASON_START);
  const daysToRegular = daysFromKSTToday(REGULAR_SEASON_START);

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
