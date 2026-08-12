"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { ChevronRight, Newspaper, Users, MessageSquare, Play } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import TeamLogo from "@/components/ui/TeamLogo";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { LG_BATTERS, POSITION_LABELS } from "@/lib/constants/players";
import playersRoster from "@/lib/constants/players-roster.json";

// 선수명 → kboId 매핑 (SSOT: /community/players/[kboId] 단일 라우트 사용)
// 레거시 /teams/[slug]/players/[mockId] 라우트는 redirect로 전환됨.
function getPlayerHref(name: string, teamId: number): string {
  const player = (playersRoster as { name: string; kboId: string; teamId: number }[]).find(
    (p) => p.name === name && p.teamId === teamId
  );
  // kboId를 못 찾으면 name으로라도 /community/players 페이지로 보냄 (해당 페이지는 name fallback 지원)
  return `/community/players/${player?.kboId ?? encodeURIComponent(name)}`;
}

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
        className="relative px-5 pb-6 pt-safe"
        style={{
          background: `linear-gradient(180deg, ${getTeamBgColor(team)}40 0%, ${getTeamBgColor(team)}10 40%, transparent 100%)`,
        }}
      >
        <div className="flex items-center gap-4 py-5">
          <TeamLogo team={team} size={64} className="shadow-lg" />
          <div>
            <h1 className="text-xl font-bold text-text-primary">{team.name}</h1>
            <div className="mt-1 flex items-center gap-4 text-base text-text-secondary">
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

      <div className="space-y-7 px-5 pb-6">
        {/* News Section */}
        <motion.section variants={item}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-4 text-lg font-semibold text-text-primary">
              <Newspaper size={22} className="text-text-secondary" />
              최신 뉴스
            </h2>
            <button className="flex items-center text-base text-text-secondary">
              전체보기 <ChevronRight size={20} />
            </button>
          </div>
          <div className="space-y-3">
            {MOCK_NEWS.map((news) => (
              <GlassCard key={news.id} pressable className="!p-4">
                <p className="text-base font-medium text-text-primary line-clamp-1">
                  {news.title}
                </p>
                <p className="mt-1 text-base text-text-tertiary">
                  {news.source} · {news.timeAgo}
                </p>
              </GlassCard>
            ))}
          </div>
        </motion.section>

        {/* Starting Lineup */}
        <motion.section variants={item}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-4 text-lg font-semibold text-text-primary">
              <Users size={22} className="text-text-secondary" />
              주전 라인업
            </h2>
            <Link
              href={`/teams/${team.slug}`}
              className="flex items-center text-base text-text-secondary"
            >
              전체 선수 <ChevronRight size={20} />
            </Link>
          </div>

          {/* SP */}
          <div className="mb-3">
            <Link href={getPlayerHref("케이시 켈리", team.id)} prefetch={false}>
              <GlassCard pressable className="!p-4">
                <div className="flex items-center gap-4">
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-base font-bold text-white"
                    style={{
                      background: `linear-gradient(135deg, ${getTeamBgColor(team)}, ${team.colorSecondary})`,
                    }}
                  >
                    SP
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <span className="text-base font-bold text-text-primary">#29 케이시 켈리</span>
                      <span className="text-base text-text-tertiary">선발</span>
                    </div>
                    <p className="text-base tabular-nums text-text-secondary">
                      ERA 3.12 · 15승 7패 · WHIP 1.15
                    </p>
                  </div>
                </div>
              </GlassCard>
            </Link>
          </div>

          {/* Batting Order */}
          <div className="space-y-2">
            {STARTING_LINEUP.map(({ order, player }) => (
              <Link key={player.id} href={getPlayerHref(player.name, team.id)} prefetch={false}>
                <GlassCard pressable className="!p-3">
                  <div className="flex items-center gap-4">
                    <span className="w-5 text-center text-base font-bold text-text-tertiary">
                      {order}
                    </span>
                    <span
                      className="w-7 text-center text-base font-semibold"
                      style={{ color: team.colorPrimary }}
                    >
                      {POSITION_LABELS[player.position] ?? player.position}
                    </span>
                    <span className="flex-1 text-base font-medium text-text-primary">
                      #{player.number} {player.name}
                    </span>
                    <span className="text-base tabular-nums text-text-secondary">
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
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-4 text-lg font-semibold text-text-primary">
              <Play size={22} className="text-text-secondary" />
              팀 콘텐츠
            </h2>
          </div>
          <div className="flex gap-4 overflow-x-auto hide-scrollbar -mx-5 px-5">
            {MOCK_YOUTUBE.map((video) => (
              <GlassCard key={video.id} pressable className="min-w-[220px] flex-shrink-0 !p-0 overflow-hidden">
                {/* Thumbnail placeholder */}
                <div
                  className="flex h-[124px] items-center justify-center"
                  style={{ backgroundColor: `${getTeamBgColor(team)}15` }}
                >
                  <Play size={34} className="text-text-tertiary" />
                </div>
                <div className="p-4">
                  <p className="text-base font-medium text-text-primary line-clamp-2">
                    {video.title}
                  </p>
                  <p className="mt-1 text-base text-text-tertiary">
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
            <GlassCard pressable className="flex items-center justify-between !p-5">
              <div className="flex items-center gap-4">
                <MessageSquare size={24} style={{ color: team.colorPrimary }} />
                <div>
                  <p className="text-base font-semibold text-text-primary">구단 게시판</p>
                  <p className="text-base text-text-secondary">{team.name} 팬들의 소통 공간</p>
                </div>
              </div>
              <ChevronRight size={22} className="text-text-tertiary" />
            </GlassCard>
          </Link>
        </motion.section>
      </div>
    </motion.div>
  );
}
