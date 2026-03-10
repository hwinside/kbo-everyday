import { useMemo } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import StatusBadge from "@/components/ui/StatusBadge";
import SectionHeader from "@/components/ui/SectionHeader";
import { getTeamShortName, getTeamColor, getTeamLogo, getTeamName } from "@/lib/utils/team";

interface HomeGame {
  id: string;
  homeTeamId: number;
  awayTeamId: number;
  time: string;
  stadium: string;
  homeScore: number;
  awayScore: number;
  status: "scheduled" | "live" | "final";
  inning: string | null;
}

const REGULAR_SEASON_START = new Date("2026-03-28");
const PRESEASON_START = new Date("2026-03-12");

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

export default function TodayGamesSection({ todayGames, isPreseason }: { todayGames: HomeGame[]; isPreseason: boolean }) {
  const currentTime = useMemo(() => new Date(), []);
  return (
    <motion.section variants={item} className="mb-6">
      <SectionHeader title={isPreseason ? "오늘의 시범경기" : "오늘의 경기"} href="/games" icon="⚾" />
      {todayGames.length > 0 && !todayGames[0]?.id?.startsWith("placeholder") ? (
        <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto hide-scrollbar -mx-5 px-5">
          {todayGames.map((game) => (
            <Link key={game.id} href={`/games/${game.id}`}>
              <GlassCard pressable className="w-[220px] h-[190px] flex-shrink-0 snap-start p-5 flex flex-col justify-between">
                <StatusBadge status={game.status} inning={game.inning} />
                <div className="flex items-center justify-between flex-1">
                  <div className="flex flex-col items-center gap-1 flex-1">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white p-1">
                      <Image src={getTeamLogo(game.awayTeamId)} alt={getTeamName(game.awayTeamId)} width={24} height={24} unoptimized className="object-contain" />
                    </div>
                    <span className="text-sm font-bold" style={{ color: getTeamColor(game.awayTeamId) }}>
                      {getTeamShortName(game.awayTeamId)}
                    </span>
                    <span className="text-lg font-bold tabular-nums text-text-primary">{game.status === "scheduled" ? "-" : game.awayScore}</span>
                  </div>
                  <span className="text-xs text-text-tertiary">vs</span>
                  <div className="flex flex-col items-center gap-1 flex-1">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white p-1">
                      <Image src={getTeamLogo(game.homeTeamId)} alt={getTeamName(game.homeTeamId)} width={24} height={24} unoptimized className="object-contain" />
                    </div>
                    <span className="text-sm font-bold" style={{ color: getTeamColor(game.homeTeamId) }}>
                      {getTeamShortName(game.homeTeamId)}
                    </span>
                    <span className="text-lg font-bold tabular-nums text-text-primary">{game.status === "scheduled" ? "-" : game.homeScore}</span>
                  </div>
                </div>
                <p className="text-center text-xs text-text-tertiary">
                  {isPreseason && <span className="text-yellow-500 font-medium">시범 · </span>}{game.time} · {game.stadium}
                </p>
              </GlassCard>
            </Link>
          ))}
        </div>
      ) : (
        <GlassCard className="p-6 text-center">
          <p className="text-2xl mb-2">⚾</p>
          {currentTime < PRESEASON_START ? (
            <>
              <p className="text-[15px] font-medium text-text-primary">시범경기 D-{Math.ceil((PRESEASON_START.getTime() - currentTime.getTime()) / 86400000)}</p>
              <p className="text-xs text-text-tertiary mt-1">3월 12일 시범경기 시작!</p>
            </>
          ) : currentTime < REGULAR_SEASON_START ? (
            <>
              <p className="text-[15px] font-medium text-text-primary">오늘은 경기가 없습니다</p>
              <p className="text-xs text-text-tertiary mt-1">시범경기 진행중 · 개막 D-{Math.ceil((REGULAR_SEASON_START.getTime() - currentTime.getTime()) / 86400000)}</p>
            </>
          ) : (
            <>
              <p className="text-[15px] font-medium text-text-primary">오늘은 경기가 없습니다</p>
              <p className="text-xs text-text-tertiary mt-1">내일 경기를 기대해주세요!</p>
            </>
          )}
        </GlassCard>
      )}
    </motion.section>
  );
}
