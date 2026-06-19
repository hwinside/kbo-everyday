"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { getTeamBgColor, type TeamData } from "@/lib/constants/teams";
import { getNextTicketOpen, formatCountdown, type NextTicketOpen } from "@/lib/utils/ticket-utils";

interface Props {
  team: TeamData;
}

export default function TeamNextTicketCard({ team }: Props) {
  const [ticketInfo, setTicketInfo] = useState<NextTicketOpen | null>(null);
  const [countdown, setCountdown] = useState("");
  // 오픈 1시간 이내 임박 여부 — tick에서 실시간 잔여로 갱신 (렌더 중 Date.now 호출 회피)
  const [near, setNear] = useState(false);

  useEffect(() => {
    let aborted = false;

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
          // 우천취소/종료 경기 제외 → 일정 변경(취소·연기)은 자동으로 다음 유효 경기로 스킵
          const home = games.find(
            (g) =>
              g.homeTeamId === team.id &&
              g.status !== "cancelled" &&
              g.status !== "final"
          );
          // 더블헤더(같은 날 2경기) 등 같은 날짜 중복 방지
          if (home && !homeGames.some((h) => h.date === home.date)) {
            homeGames.push({ date: home.date });
          }
        } catch {
          /* skip */
        }
      }

      if (aborted) return;
      // 최신 일정으로 재계산 → on_sale 경기가 취소/변경됐어도 다음 fetch에서 자동 보정
      setTicketInfo(getNextTicketOpen(team.id, homeGames));
    }

    fetchHomeGames();

    // 카드를 열어둔 사이 우천 연기/더블헤더 추가/취소 등 일정 변경 반영:
    // 가시 상태일 때만 주기 재조회 + 앱/탭 복귀(visibilitychange) 시 재조회
    const REFRESH_MS = 10 * 60 * 1000;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchHomeGames();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchHomeGames();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      aborted = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [team.id]);

  useEffect(() => {
    if (!ticketInfo || ticketInfo.status !== "countdown") return;

    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      const ms = ticketInfo!.openAt.getTime() - Date.now();
      setCountdown(formatCountdown(ms));
      setNear(ms > 0 && ms < 60 * 60 * 1000);
      // 오픈 시각 지나면 판매 중으로 전환
      if (ms <= 0) {
        setTicketInfo((prev) => (prev ? { ...prev, status: "on_sale", msUntilOpen: 0 } : null));
        return;
      }
      // 매 틱마다 남은 시간 기준으로 다음 간격 재계산 → 페이지 열어둔 채 임박(1시간 이내) 구간 진입해도 1초 카운트다운/LIVE로 전환됨
      timer = setTimeout(tick, ms < 60 * 60 * 1000 ? 1000 : 60_000);
    }

    tick();
    return () => clearTimeout(timer);
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

  const isNear = ticketInfo.status === "countdown" && near;
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
