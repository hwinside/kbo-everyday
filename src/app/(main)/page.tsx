"use client";

import { motion } from "framer-motion";
import { Bell, ChevronRight, Flame, Users } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import { TEAMS } from "@/lib/constants/teams";
import { MOCK_PREDICTIONS } from "@/lib/constants/predictions";
import { MOCK_NEWS } from "@/lib/constants/news";

/* ===== Mock Data ===== */
const MOCK_GAMES = [
  { id: "20260328-LG-DS", homeTeamId: 2, awayTeamId: 1, time: "18:30", stadium: "잠실", homeScore: 3, awayScore: 5, status: "live" as const, inning: "6회말" },
  { id: "20260328-SSG-HH", homeTeamId: 4, awayTeamId: 9, time: "18:30", stadium: "인천", homeScore: 0, awayScore: 0, status: "scheduled" as const, inning: null },
  { id: "20260328-KT-NC", homeTeamId: 3, awayTeamId: 5, time: "18:30", stadium: "수원", homeScore: 2, awayScore: 1, status: "live" as const, inning: "4회초" },
  { id: "20260328-KIA-LT", homeTeamId: 6, awayTeamId: 7, time: "14:00", stadium: "광주", homeScore: 7, awayScore: 3, status: "final" as const, inning: "종료" },
  { id: "20260328-SS-KW", homeTeamId: 8, awayTeamId: 10, time: "18:30", stadium: "대구", homeScore: 1, awayScore: 1, status: "live" as const, inning: "3회초" },
];


const MOCK_HOT_PLAYER_BOARDS = [
  { playerId: "p1", name: "오스틴", teamId: 1, teamName: "LG", postsToday: 47, totalPosts: 1284, trend: "up" as const },
  { playerId: "p2", name: "양현종", teamId: 6, teamName: "KIA", postsToday: 38, totalPosts: 956, trend: "up" as const },
  { playerId: "p3", name: "구자욱", teamId: 8, teamName: "삼성", postsToday: 35, totalPosts: 1102, trend: "same" as const },
  { playerId: "p4", name: "김도영", teamId: 6, teamName: "KIA", postsToday: 33, totalPosts: 2341, trend: "up" as const },
  { playerId: "p5", name: "문동주", teamId: 9, teamName: "한화", postsToday: 28, totalPosts: 876, trend: "down" as const },
];

const MOCK_POPULAR_POSTS = [
  { id: 1, title: "오늘의 선발 라인업 예상", boardId: "lg", author: "엘지골드", likeCount: 42, commentCount: 18, teamId: 1 },
  { id: 2, title: "올해 우승은 반드시 우리가 한다", boardId: "kia", author: "타이거팬", likeCount: 38, commentCount: 24, teamId: 6 },
  { id: 3, title: "신인 드래프트 1순위 분석", boardId: "samsung", author: "야구박사", likeCount: 31, commentCount: 12, teamId: 8 },
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

function getTeamShortName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? "";
}

function getTeamColor(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.colorPrimary ?? "#666";
}

function getTeamLogo(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.logoPath ?? "";
}

function getTeamName(teamId: number) {
  return TEAMS.find((t) => t.id === teamId)?.name ?? "";
}

function StatusBadge({ status, inning }: { status: string; inning: string | null }) {
  if (status === "live") {
    return (
      <span className="flex items-center gap-1 text-xs font-semibold text-accent-green">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-green animate-pulse" />
        {inning}
      </span>
    );
  }
  if (status === "final") {
    return <span className="text-xs text-text-secondary">종료</span>;
  }
  return <span className="text-xs text-text-secondary">예정</span>;
}

function SectionHeader({ title, href, icon }: { title: string; href: string; icon: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-1.5 text-base font-semibold text-text-primary">
        <span>{icon}</span> {title}
      </h2>
      <Link
        href={href}
        className="flex items-center text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        전체보기 <ChevronRight size={14} />
      </Link>
    </div>
  );
}

export default function HomePage() {
  // Show first 2 predictions for preview
  const previewPredictions = MOCK_PREDICTIONS.filter((p) => p.status === "open").slice(0, 2);
  // Show first 3 news
  const previewNews = MOCK_NEWS.slice(0, 3);

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-lg px-4 pt-safe"
    >
      {/* Header */}
      <motion.header variants={item} className="flex items-center justify-between py-4">
        <h1 className="text-xl font-bold text-text-primary">크보 에브리데이</h1>
        <button className="rounded-full p-2 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <Bell size={20} />
        </button>
      </motion.header>

      {/* ===== 1. Today's Games — horizontal scroll with snap ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title="오늘의 경기" href="/games" icon="⚾" />
        <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto hide-scrollbar -mx-4 px-4">
          {MOCK_GAMES.map((game) => (
            <Link key={game.id} href={`/games/${game.id}`}>
              <GlassCard pressable className="w-[200px] h-[150px] flex-shrink-0 snap-start p-3 flex flex-col justify-between">
                <StatusBadge status={game.status} inning={game.inning} />
                <div className="flex items-center justify-between flex-1">
                  <div className="flex flex-col items-center gap-1 flex-1">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white p-1">
                      <Image src={getTeamLogo(game.awayTeamId)} alt={getTeamName(game.awayTeamId)} width={24} height={24} unoptimized className="object-contain" />
                    </div>
                    <span className="text-[11px] font-bold" style={{ color: getTeamColor(game.awayTeamId) }}>
                      {getTeamShortName(game.awayTeamId)}
                    </span>
                    <span className="text-xl font-bold tabular-nums text-text-primary">{game.status === "scheduled" ? "-" : game.awayScore}</span>
                  </div>
                  <span className="text-xs text-text-tertiary">vs</span>
                  <div className="flex flex-col items-center gap-1 flex-1">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white p-1">
                      <Image src={getTeamLogo(game.homeTeamId)} alt={getTeamName(game.homeTeamId)} width={24} height={24} unoptimized className="object-contain" />
                    </div>
                    <span className="text-[11px] font-bold" style={{ color: getTeamColor(game.homeTeamId) }}>
                      {getTeamShortName(game.homeTeamId)}
                    </span>
                    <span className="text-xl font-bold tabular-nums text-text-primary">{game.status === "scheduled" ? "-" : game.homeScore}</span>
                  </div>
                </div>
                <p className="text-center text-[11px] text-text-tertiary">
                  {game.time} · {game.stadium}
                </p>
              </GlassCard>
            </Link>
          ))}
        </div>
      </motion.section>

      {/* ===== 2. Prediction Preview ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title="승부예측" href="/predict" icon="🔮" />
        <div className="space-y-3">
          {previewPredictions.map((pred) => (
            <Link key={pred.gameId} href="/predict">
              <GlassCard pressable className="p-3">
                <div className="flex items-center justify-between text-sm font-semibold">
                  <span className="flex items-center gap-1.5" style={{ color: getTeamColor(pred.awayTeamId) }}>
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white p-0.5">
                      <Image src={getTeamLogo(pred.awayTeamId)} alt={getTeamName(pred.awayTeamId)} width={18} height={18} unoptimized className="object-contain" />
                    </span>
                    {getTeamShortName(pred.awayTeamId)}
                  </span>
                  <span className="text-xs text-text-tertiary">vs</span>
                  <span className="flex items-center gap-1.5" style={{ color: getTeamColor(pred.homeTeamId) }}>
                    {getTeamShortName(pred.homeTeamId)}
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white p-0.5">
                      <Image src={getTeamLogo(pred.homeTeamId)} alt={getTeamName(pred.homeTeamId)} width={18} height={18} unoptimized className="object-contain" />
                    </span>
                  </span>
                </div>
                {/* Prediction bar */}
                <div className="mt-2 flex h-2.5 overflow-hidden rounded-full">
                  <motion.div
                    className="rounded-l-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${pred.awayPercent}%` }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                    style={{ backgroundColor: getTeamColor(pred.awayTeamId) }}
                  />
                  <motion.div
                    className="rounded-r-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${pred.homePercent}%` }}
                    transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
                    style={{ backgroundColor: getTeamColor(pred.homeTeamId) }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-[11px] text-text-secondary">
                  <span className="font-semibold" style={{ color: getTeamColor(pred.awayTeamId) }}>
                    {getTeamShortName(pred.awayTeamId)} {pred.awayPercent}%
                  </span>
                  <span className="flex items-center gap-1">
                    <Users size={10} />
                    {pred.totalVotes.toLocaleString()}명
                  </span>
                  <span className="font-semibold" style={{ color: getTeamColor(pred.homeTeamId) }}>
                    {pred.homePercent}% {getTeamShortName(pred.homeTeamId)}
                  </span>
                </div>
              </GlassCard>
            </Link>
          ))}
        </div>
      </motion.section>

      {/* ===== 3. Latest News ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title="최신 뉴스" href="/news" icon="📰" />
        <div className="space-y-3">
          {previewNews.map((news) => (
            <Link key={news.id} href="/news">
              <GlassCard pressable className="p-3">
                <div className="flex items-start gap-3">
                  {/* Thumbnail placeholder */}
                  <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-xl text-text-tertiary">
                    📰
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary line-clamp-2">{news.title}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      {news.teamId && <TeamBadge teamId={news.teamId} />}
                      <span className="text-[11px] text-text-tertiary">{news.source} · {news.timeAgo}</span>
                    </div>
                  </div>
                </div>
              </GlassCard>
            </Link>
          ))}
        </div>
      </motion.section>

      {/* ===== 4. Popular Posts ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title="인기글" href="/teams" icon="🔥" />
        <div className="space-y-2">
          {MOCK_POPULAR_POSTS.map((post, i) => (
            <GlassCard key={post.id} pressable className="p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/10 text-[11px] font-bold text-accent">
                  {i + 1}
                </span>
                <TeamBadge teamId={post.teamId} />
                <span className="flex-1 truncate text-sm text-text-primary">{post.title}</span>
              </div>
              <div className="mt-1 flex items-center gap-3 pl-7 text-[11px] text-text-tertiary">
                <span>{post.author}</span>
                <span>❤️ {post.likeCount}</span>
                <span>💬 {post.commentCount}</span>
              </div>
            </GlassCard>
          ))}
        </div>
      </motion.section>


      {/* ===== 5. Hot Player Boards ===== */}
      <motion.section variants={item} className="mb-6">
        <SectionHeader title="인기 선수게시판" href="/teams" icon="⭐" />
        <GlassCard className="p-3">
          <div className="space-y-3">
            {MOCK_HOT_PLAYER_BOARDS.map((player, i) => (
              <div key={player.playerId} className="flex items-center gap-3">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                  i === 0 ? "bg-yellow-500/20 text-yellow-400" :
                  i === 1 ? "bg-gray-400/20 text-gray-300" :
                  i === 2 ? "bg-amber-700/20 text-amber-600" :
                  "bg-bg-tertiary text-text-tertiary"
                }`}>
                  {i + 1}
                </span>
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-white p-0.5">
                  <Image src={getTeamLogo(player.teamId)} alt={player.teamName} width={18} height={18} unoptimized className="object-contain" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-semibold text-text-primary">{player.name}</span>
                  <span className="ml-1.5 text-[11px] text-text-tertiary">{player.teamName}</span>
                </div>
                <div className="text-right">
                  <div className="text-xs font-bold text-accent">오늘 {player.postsToday}글</div>
                  <div className="text-[10px] text-text-tertiary">총 {player.totalPosts.toLocaleString()}글</div>
                </div>
                <span className="text-sm">
                  {player.trend === "up" ? "🔥" : player.trend === "down" ? "📉" : "➖"}
                </span>
              </div>
            ))}
          </div>
        </GlassCard>
      </motion.section>
      {/* Bottom spacer */}
      <div className="h-4" />
    </motion.div>
  );
}
