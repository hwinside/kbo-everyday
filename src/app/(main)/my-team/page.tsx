"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { ChevronRight, Newspaper, Users, MessageSquare, Play } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import { getTeamById } from "@/lib/constants/teams";
import { LG_BATTERS, POSITION_LABELS } from "@/lib/constants/players";

const MY_TEAM_ID = 1; // LG 트윈스

const MOCK_STANDING = {
  rank: 1,
  wins: 85,
  losses: 56,
  draws: 3,
  pct: 0.603,
  streak: "3연승",
};

const MOCK_NEWS = [
  { id: 1, title: "오스틴, 시즌 28호 홈런… 타격 3관왕 독주", source: "스포츠조선", timeAgo: "1시간 전" },
  { id: 2, title: "케이시 켈리, 시즌 15승 달성… 에이스의 품격", source: "OSEN", timeAgo: "3시간 전" },
  { id: 3, title: "LG, 2위와 1.5게임 차… 가을야구 확정 눈앞", source: "일간스포츠", timeAgo: "5시간 전" },
  { id: 4, title: "구본혁 올스타 MVP 선정, 차세대 유격수 자리매김", source: "스포츠서울", timeAgo: "8시간 전" },
];

const MOCK_YOUTUBE = [
  { id: "yt1", title: "LG 트윈스 vs 두산 베어스 하이라이트 | 9월 19일", views: "12만", thumbnail: null },
  { id: "yt2", title: "오스틴 시즌 28호 대포! 잠실 폭발 현장", views: "8.5만", thumbnail: null },
  { id: "yt3", title: "[응원가] 2026 LG 트윈스 새 응원가 모음", views: "45만", thumbnail: null },
];

// 주전 라인업 (타순)
const STARTING_LINEUP = [
  { order: 1, player: LG_BATTERS[1] }, // 홍창기
  { order: 2, player: LG_BATTERS[2] }, // 구본혁
  { order: 3, player: LG_BATTERS[0] }, // 오스틴
  { order: 4, player: LG_BATTERS[4] }, // 문보경
  { order: 5, player: LG_BATTERS[3] }, // 김현수
  { order: 6, player: LG_BATTERS[8] }, // 문성주
  { order: 7, player: LG_BATTERS[5] }, // 박해민
  { order: 8, player: LG_BATTERS[6] }, // 박동원
  { order: 9, player: LG_BATTERS[7] }, // 신민재
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

export default function MyTeamPage() {
  const team = getTeamById(MY_TEAM_ID)!;

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-lg"
    >
      {/* Team Header with Gradient */}
      <motion.div
        variants={item}
        className="relative px-4 pb-6 pt-safe"
        style={{
          background: `linear-gradient(180deg, ${team.colorPrimary}40 0%, ${team.colorPrimary}10 40%, transparent 100%)`,
        }}
      >
        <div className="flex items-center gap-4 py-4">
          <div
            className="flex h-16 w-16 items-center justify-center rounded-2xl text-lg font-bold text-white shadow-lg"
            style={{ backgroundColor: team.colorPrimary }}
          >
            {team.shortName}
          </div>
          <div>
            <h1 className="text-xl font-bold text-text-primary">{team.name}</h1>
            <div className="mt-1 flex items-center gap-2 text-sm text-text-secondary">
              <span className="font-semibold" style={{ color: team.colorPrimary }}>
                {MOCK_STANDING.rank}위
              </span>
              <span>·</span>
              <span>{MOCK_STANDING.wins}승 {MOCK_STANDING.losses}패 {MOCK_STANDING.draws}무</span>
              <span>·</span>
              <span>{MOCK_STANDING.streak}</span>
            </div>
          </div>
        </div>
      </motion.div>

      <div className="space-y-6 px-4 pb-6">
        {/* News Section */}
        <motion.section variants={item}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <Newspaper size={16} className="text-text-secondary" />
              최신 뉴스
            </h2>
            <button className="flex items-center text-xs text-text-secondary">
              전체보기 <ChevronRight size={14} />
            </button>
          </div>
          <div className="space-y-2">
            {MOCK_NEWS.map((news) => (
              <GlassCard key={news.id} pressable className="!p-3">
                <p className="text-sm font-medium text-text-primary line-clamp-1">
                  {news.title}
                </p>
                <p className="mt-1 text-[11px] text-text-tertiary">
                  {news.source} · {news.timeAgo}
                </p>
              </GlassCard>
            ))}
          </div>
        </motion.section>

        {/* Starting Lineup */}
        <motion.section variants={item}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <Users size={16} className="text-text-secondary" />
              주전 라인업
            </h2>
            <Link
              href={`/teams/${team.slug}`}
              className="flex items-center text-xs text-text-secondary"
            >
              전체 선수 <ChevronRight size={14} />
            </Link>
          </div>

          {/* SP */}
          <div className="mb-2">
            <Link href={`/teams/${team.slug}/players/201`}>
              <GlassCard pressable className="!p-3">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white"
                    style={{ backgroundColor: team.colorPrimary }}
                  >
                    SP
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-text-primary">#29 케이시 켈리</span>
                      <span className="text-xs text-text-tertiary">선발</span>
                    </div>
                    <p className="text-xs tabular-nums text-text-secondary">
                      ERA 3.12 · 15승 7패 · WHIP 1.15
                    </p>
                  </div>
                </div>
              </GlassCard>
            </Link>
          </div>

          {/* Batting Order */}
          <div className="space-y-1.5">
            {STARTING_LINEUP.map(({ order, player }) => (
              <Link key={player.id} href={`/teams/${team.slug}/players/${player.id}`}>
                <GlassCard pressable className="!p-2.5">
                  <div className="flex items-center gap-3">
                    <span className="w-5 text-center text-xs font-bold text-text-tertiary">
                      {order}
                    </span>
                    <span
                      className="w-7 text-center text-[11px] font-semibold"
                      style={{ color: team.colorPrimary }}
                    >
                      {POSITION_LABELS[player.position] ?? player.position}
                    </span>
                    <span className="flex-1 text-sm font-medium text-text-primary">
                      #{player.number} {player.name}
                    </span>
                    <span className="text-xs tabular-nums text-text-secondary">
                      {player.seasonStats.avg?.toFixed(3).slice(1)} / {player.seasonStats.hr}HR / {player.seasonStats.rbi}RBI
                    </span>
                  </div>
                </GlassCard>
              </Link>
            ))}
          </div>
        </motion.section>

        {/* Team Content (YouTube) */}
        <motion.section variants={item}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <Play size={16} className="text-text-secondary" />
              팀 콘텐츠
            </h2>
          </div>
          <div className="flex gap-3 overflow-x-auto hide-scrollbar -mx-4 px-4">
            {MOCK_YOUTUBE.map((video) => (
              <GlassCard key={video.id} pressable className="min-w-[220px] flex-shrink-0 !p-0 overflow-hidden">
                {/* Thumbnail placeholder */}
                <div
                  className="flex h-[124px] items-center justify-center"
                  style={{ backgroundColor: `${team.colorPrimary}15` }}
                >
                  <Play size={32} className="text-text-tertiary" />
                </div>
                <div className="p-3">
                  <p className="text-xs font-medium text-text-primary line-clamp-2">
                    {video.title}
                  </p>
                  <p className="mt-1 text-[11px] text-text-tertiary">
                    조회수 {video.views}회
                  </p>
                </div>
              </GlassCard>
            ))}
          </div>
        </motion.section>

        {/* Community Link */}
        <motion.section variants={item}>
          <Link href={`/teams/${team.slug}`}>
            <GlassCard pressable className="flex items-center justify-between !p-4">
              <div className="flex items-center gap-3">
                <MessageSquare size={20} style={{ color: team.colorPrimary }} />
                <div>
                  <p className="text-sm font-semibold text-text-primary">구단 게시판</p>
                  <p className="text-xs text-text-secondary">{team.name} 팬들의 소통 공간</p>
                </div>
              </div>
              <ChevronRight size={18} className="text-text-tertiary" />
            </GlassCard>
          </Link>
        </motion.section>
      </div>
    </motion.div>
  );
}
