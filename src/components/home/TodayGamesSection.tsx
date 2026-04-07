import { useMemo } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import SectionHeader from "@/components/ui/SectionHeader";
import { getTeamShortName, getTeamColor, getTeamLogo, getTeamName } from "@/lib/utils/team";
import { daysFromKSTToday } from "@/lib/utils/date-kst";

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

const PRESEASON_START_STR = "2026-03-12";
const REGULAR_SEASON_START_STR = "2026-03-28";

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

function CompactRowCard({ game, isPreseason, isMyGame }: { game: HomeGame; isPreseason: boolean; isMyGame: boolean }) {
  const away = { short: getTeamShortName(game.awayTeamId), color: getTeamColor(game.awayTeamId), logo: getTeamLogo(game.awayTeamId), name: getTeamName(game.awayTeamId) };
  const home = { short: getTeamShortName(game.homeTeamId), color: getTeamColor(game.homeTeamId), logo: getTeamLogo(game.homeTeamId), name: getTeamName(game.homeTeamId) };
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const awayWin = isFinal && game.awayScore > game.homeScore;
  const homeWin = isFinal && game.homeScore > game.awayScore;

  return (
    <Link href={`/games/${game.id}`}>
      <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl bg-bg-secondary/60 hover:bg-bg-tertiary transition-colors ${isMyGame ? "border-l-[3px] border-l-accent" : ""}`}>
        {/* Status badge */}
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap flex-shrink-0 ${
          isLive ? "bg-red-500/20 text-red-400" :
          isFinal ? "bg-text-tertiary/20 text-text-tertiary" :
          "bg-accent/20 text-accent"
        }`}>
          {isLive ? `LIVE ${game.inning || ""}` : isFinal ? "종료" : game.time}
        </span>

        {/* Away team */}
        <div className={`flex items-center gap-1.5 flex-1 min-w-0 ${isFinal && !awayWin ? "opacity-45" : ""}`}>
          <div className="w-6 h-6 rounded-full bg-gray-100 dark:bg-white p-0.5 flex items-center justify-center flex-shrink-0">
            <Image src={away.logo} alt={away.name} width={16} height={16} unoptimized className="object-contain" />
          </div>
          <span className="text-[13px] font-semibold truncate" style={{ color: away.color }}>{away.short}</span>
        </div>

        {/* Score */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {game.status === "scheduled" ? (
            <span className="text-xs text-text-tertiary">vs</span>
          ) : (
            <>
              <span className={`text-base font-bold tabular-nums ${awayWin ? "text-text-primary" : isFinal ? "text-text-tertiary" : "text-text-primary"}`}>{game.awayScore}</span>
              <span className="text-xs text-text-tertiary">:</span>
              <span className={`text-base font-bold tabular-nums ${homeWin ? "text-text-primary" : isFinal ? "text-text-tertiary" : "text-text-primary"}`}>{game.homeScore}</span>
            </>
          )}
        </div>

        {/* Home team */}
        <div className={`flex items-center gap-1.5 flex-1 min-w-0 justify-end ${isFinal && !homeWin ? "opacity-45" : ""}`}>
          <span className="text-[13px] font-semibold truncate" style={{ color: home.color }}>{home.short}</span>
          <div className="w-6 h-6 rounded-full bg-gray-100 dark:bg-white p-0.5 flex items-center justify-center flex-shrink-0">
            <Image src={home.logo} alt={home.name} width={16} height={16} unoptimized className="object-contain" />
          </div>
        </div>

        {/* Stadium */}
        <span className="text-[10px] text-text-tertiary flex-shrink-0">{game.stadium}</span>
      </div>
    </Link>
  );
}

export default function TodayGamesSection({ todayGames, isPreseason, myTeamId }: { todayGames: HomeGame[]; isPreseason: boolean; myTeamId?: number | null }) {
  const daysToPreseason = useMemo(() => daysFromKSTToday(PRESEASON_START_STR), []);
  const daysToRegular = useMemo(() => daysFromKSTToday(REGULAR_SEASON_START_STR), []);
  return (
    <motion.section variants={item} className="mb-6 -mx-5 px-5 py-4 bg-bg-tertiary/50 dark:bg-transparent rounded-none">
      <SectionHeader title={isPreseason ? "오늘의 시범경기" : "오늘의 경기"} href="/games" icon="⚾" />
      {todayGames.length > 0 && !todayGames[0]?.id?.startsWith("placeholder") ? (
        <div className="flex flex-col gap-1.5">
          {todayGames.map((game) => {
            const isMyGame = myTeamId != null && (game.homeTeamId === myTeamId || game.awayTeamId === myTeamId);
            return (
              <CompactRowCard key={game.id} game={game} isPreseason={isPreseason} isMyGame={isMyGame} />
            );
          })}
        </div>
      ) : (
        <GlassCard className="p-6 text-center">
          <p className="text-2xl mb-2">⚾</p>
          {daysToPreseason > 0 ? (
            <>
              <p className="text-[15px] font-medium text-text-primary">시범경기 D-{daysToPreseason}</p>
              <p className="text-xs text-text-tertiary mt-1">3월 12일 시범경기 시작!</p>
            </>
          ) : daysToRegular > 0 ? (
            <>
              <p className="text-[15px] font-medium text-text-primary">오늘은 경기가 없습니다</p>
              <p className="text-xs text-text-tertiary mt-1">시범경기 진행중 · 개막 D-{daysToRegular}</p>
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
