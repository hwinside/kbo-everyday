"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { getTeamBgColor, type TeamData } from "@/lib/constants/teams";
import { getNextTicketOpen, formatCountdown, type NextTicketOpen } from "@/lib/utils/ticket-utils";

interface Props {
  team: TeamData;
}

export default function TeamNextTicketCard({ team }: Props) {
  const [ticketInfo, setTicketInfo] = useState<NextTicketOpen | null>(null);
  const [countdown, setCountdown] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    async function fetchHomeGames() {
      const homeGames: Array<{ date: string }> = [];
      const now = new Date();

      for (let i = 0; i < 21 && homeGames.length < 6; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        const dateStr = d
          .toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })
          .replace(/-/g, "");
        try {
          const res = await fetch(`/api/games?date=${dateStr}`);
          if (!res.ok) continue;
          const data = await res.json();
          const games: Array<{ homeTeamId: number; status: string; date: string }> =
            data.games ?? data;
          if (!Array.isArray(games)) continue;
          const home = games.find(
            (g) =>
              g.homeTeamId === team.id &&
              g.status !== "cancelled" &&
              g.status !== "final"
          );
          if (home) homeGames.push({ date: home.date });
        } catch {
          /* skip */
        }
      }

      const info = getNextTicketOpen(team.id, homeGames);
      setTicketInfo(info);
    }

    fetchHomeGames();
  }, [team.id]);

  useEffect(() => {
    if (!ticketInfo || ticketInfo.status !== "countdown") return;

    function tick() {
      const ms = ticketInfo!.openAt.getTime() - Date.now();
      setCountdown(formatCountdown(ms));
      // transition to on_sale if time passed
      if (ms <= 0) {
        setTicketInfo((prev) => prev ? { ...prev, status: "on_sale", msUntilOpen: 0 } : null);
      }
    }

    tick();
    const isNear = ticketInfo.msUntilOpen < 60 * 60 * 1000;
    intervalRef.current = setInterval(tick, isNear ? 1000 : 60_000);
    return () => clearInterval(intervalRef.current);
  }, [ticketInfo]);

  if (!ticketInfo) return null;

  const gd = ticketInfo.gameDate;
  const gameDate = new Date(
    parseInt(gd.slice(0, 4)),
    parseInt(gd.slice(4, 6)) - 1,
    parseInt(gd.slice(6, 8))
  );
  const gameDateLabel = gameDate.toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
    weekday: "short",
  });

  const isNear =
    ticketInfo.status === "countdown" && ticketInfo.msUntilOpen < 60 * 60 * 1000;
  const bgColor = getTeamBgColor(team);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-5 mb-4 rounded-2xl p-4 flex items-center gap-3"
      style={{
        backgroundColor: `${bgColor}12`,
        border: `1px solid ${bgColor}28`,
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-xs text-text-tertiary">다음 예매 오픈</p>
          {isNear && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
          )}
        </div>
        <p className="text-sm font-bold text-text-primary">
          {ticketInfo.status === "on_sale" ? "지금 예매 중" : countdown}
        </p>
        <p className="text-xs text-text-secondary mt-0.5">
          {gameDateLabel} 홈경기 · {ticketInfo.provider}
        </p>
      </div>
      <a
        href={ticketInfo.buyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold text-white"
        style={{ backgroundColor: bgColor }}
      >
        예매하기
      </a>
    </motion.div>
  );
}
