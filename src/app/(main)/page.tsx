"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, ChevronRight } from "lucide-react";
import Link from "next/link";
import GlassCard from "@/components/ui/GlassCard";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import PlayerSelectModal from "@/components/onboarding/PlayerSelectModal";
import LoginSheet from "@/components/auth/LoginSheet";
import NewsCarousel from "@/components/news/NewsCarousel";
import HomeHighlights from "@/components/home/HomeHighlights";
import HomeOfficialVideos from "@/components/home/HomeOfficialVideos";
import LiveGameBanner from "@/components/home/LiveGameBanner";
import PWAInstallBanner from "@/components/ui/PWAInstallBanner";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import { useLiveGame } from "@/lib/hooks/useLiveGame";
// MOCK_NEWS removed — using localStorage cache instead
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { getTeamBgColorById, getTeamColor } from "@/lib/utils/team";
import { useHomeNews } from "@/hooks/useHomeNews";
import { useHomeInit } from "@/hooks/useHomeInit";
import HeaderAvatar from "@/components/home/HeaderAvatar";
import MyTeamHero from "@/components/home/MyTeamHero";
import FavoritePlayersSection from "@/components/home/FavoritePlayersSection";
import TodayGamesSection from "@/components/home/TodayGamesSection";
import AIAnalysis from "@/components/game/AIAnalysis";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

export default function HomePage() {
  const [aiGame, setAiGame] = useState<{awayTeamId: number; homeTeamId: number; gameId: string} | null>(null);
  const [showLogin, setShowLogin] = useState(false);

  const {
    user, profile,
    myTeamId, favPlayers,
    showOnboarding, showPlayerSelect, setShowPlayerSelect,
    showPlayerSetupCTA, setShowPlayerSetupCTA,
    welcomeToast,
    todayGames, isPreseason,
    handleOnboardingComplete, handlePlayerSelect,
  } = useHomeInit();

  const realNews = useHomeNews(myTeamId);
  const myTeam = myTeamId ? getTeamById(myTeamId) : null;
  const myTeamGameBase = todayGames.find(g => g.homeTeamId === myTeamId || g.awayTeamId === myTeamId);
  const { liveGames } = useLiveGame(undefined, 15000);
  const myTeamLive = myTeamGameBase ? liveGames.find(g => g.gameId === myTeamGameBase.id) : undefined;
  const myTeamGame = myTeamGameBase ? {
    ...myTeamGameBase,
    balls: myTeamLive?.balls ?? 0,
    strikes: myTeamLive?.strikes ?? 0,
    outs: myTeamLive?.outs ?? 0,
    runner1b: myTeamLive?.runner1b ?? false,
    runner2b: myTeamLive?.runner2b ?? false,
    runner3b: myTeamLive?.runner3b ?? false,
    currentBatter: myTeamLive?.currentBatter ?? null,
    currentPitcher: myTeamLive?.currentPitcher ?? null,
    isTop: myTeamLive?.isTop ?? true,
    ...(myTeamLive ? {
      homeScore: myTeamLive.homeScore,
      awayScore: myTeamLive.awayScore,
      status: myTeamLive.isLive ? "live" as const : "final" as const,
      inning: myTeamLive.currentInning || null,
    } : {}),
  } : undefined;

  return (
    <>
    {/* 환영 토스트 */}
    <AnimatePresence>
      {welcomeToast && (
        <motion.div
          initial={{ opacity: 0, y: -40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -40 }}
          className="fixed top-14 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl bg-bg-secondary border border-black/10 dark:border-white/10 shadow-lg"
        >
          <p className="text-sm font-medium text-text-primary">👋 {profile?.nickname}님 환영합니다!</p>
        </motion.div>
      )}
    </AnimatePresence>

    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-lg px-5"
    >
      {/* Header */}
      <motion.header variants={item} className="flex items-center justify-between py-3 border-b mb-2 -mx-5 px-5" style={{ borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)' }}>
        <div className="flex flex-col">
          <img src="/logo-mark-light.png" alt="크보팬" style={{height: "52px", objectFit: "contain"}} className="-ml-0.5 dark:hidden" />
          <img src="/logo-mark.png" alt="크보팬" style={{height: "52px", objectFit: "contain"}} className="-ml-0.5 hidden dark:block" />
        </div>
        <div className="flex items-center gap-1">
          <button className="rounded-full p-2 text-text-secondary hover:bg-bg-tertiary transition-colors">
            <Bell size={22} />
          </button>
          <Link href="/my" className="rounded-full p-2 hover:bg-bg-tertiary transition-colors">
            <HeaderAvatar user={user} profile={profile} />
          </Link>
        </div>
      </motion.header>

      <PWAInstallBanner />

      {/* 스킵 유저: 최애선수 설정 CTA */}
      {showPlayerSetupCTA && myTeamId && (
        <motion.div variants={item} className="mb-3">
          <button
            onClick={() => setShowPlayerSelect(true)}
            className="w-full p-4 rounded-2xl flex items-center gap-3 transition-colors"
            style={{
              background: `${getTeamBgColorById(myTeamId)}12`,
              border: `1px solid ${getTeamColor(myTeamId)}20`,
            }}
          >
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: `${getTeamBgColorById(myTeamId)}25` }}>
              <span className="text-lg">⭐</span>
            </div>
            <div className="flex-1 text-left">
              <p className="text-[15px] leading-[22px] font-medium text-text-primary">최애선수 설정하고 홈을 꾸며보세요</p>
              <p className="text-xs leading-[18px] text-text-tertiary mt-0.5">선수 소식/기록을 더 잘 추천해드려요</p>
            </div>
            <ChevronRight size={18} className="text-text-tertiary" />
          </button>
        </motion.div>
      )}

      {/* News Carousel */}
      {realNews.length > 0 && (
        <div className="mb-3">
          <div className="-mx-5"><NewsCarousel news={realNews.slice(0, 10)} /></div>
        </div>
      )}

      {/* My Team Hero */}
      {myTeam && myTeamGame && (
        <MyTeamHero myTeam={myTeam} myTeamGame={myTeamGame} />
      )}

      <div className="mb-3">
        <FavoritePlayersSection favPlayers={favPlayers} />

        <HomeHighlights team={myTeamId ? TEAMS.find(t => t.id === myTeamId)?.shortName || null : null} />
        <HomeOfficialVideos team={myTeamId ? TEAMS.find(t => t.id === myTeamId)?.shortName || null : null} />
      </div>

      <LiveGameBanner excludeGameId={myTeamGameBase?.id} liveGames={liveGames} />
      <TodayGamesSection todayGames={todayGames} isPreseason={isPreseason} myTeamId={myTeamId} />

      {/* 퀵액션 버튼 */}
      <motion.div variants={item} className="flex gap-3 mb-6">
        <Link href="/community/tickets" className="flex-1">
          <GlassCard pressable className="flex items-center gap-3 !p-4">
            <span className="text-lg">🎫</span>
            <span className="text-[15px] leading-[22px] font-medium text-text-primary">티켓양도</span>
          </GlassCard>
        </Link>
        <Link href="/community/stadiums" className="flex-1">
          <GlassCard pressable className="flex items-center gap-3 !p-4">
            <span className="text-lg">🏟️</span>
            <span className="text-[15px] leading-[22px] font-medium text-text-primary">구장가이드</span>
          </GlassCard>
        </Link>
      </motion.div>

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      <div className="h-4" />
    </motion.div>

    {showOnboarding && (
      <OnboardingFlow onComplete={handleOnboardingComplete} />
    )}
    <PlayerSelectModal
      isOpen={showPlayerSelect}
      teamId={myTeamId ?? 1}
      onComplete={handlePlayerSelect}
      onSkip={() => {
        setShowPlayerSelect(false);
        setShowPlayerSetupCTA(false);
      }}
    />

    {aiGame && (
      <AIAnalysis
        isOpen={true}
        onClose={() => setAiGame(null)}
        awayTeamId={aiGame.awayTeamId}
        homeTeamId={aiGame.homeTeamId}
        gameId={aiGame.gameId}
      />
    )}
    </>
  );
}
