"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { clsx } from "clsx";
import { TEAMS } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import type { TeamStanding } from "@/lib/types";

const MOCK_STANDINGS: TeamStanding[] = [
  { teamId: 1, season: 2026, rank: 1, wins: 85, losses: 56, draws: 3, pct: 0.603, gb: 0, streak: "3연승", last10: "7승3패" },
  { teamId: 9, season: 2026, rank: 2, wins: 83, losses: 57, draws: 4, pct: 0.593, gb: 1.5, streak: "2연승", last10: "6승4패" },
  { teamId: 4, season: 2026, rank: 3, wins: 75, losses: 64, draws: 5, pct: 0.536, gb: 9.5, streak: "1연패", last10: "5승5패" },
  { teamId: 6, season: 2026, rank: 4, wins: 73, losses: 67, draws: 4, pct: 0.521, gb: 12, streak: "1연승", last10: "6승4패" },
  { teamId: 5, season: 2026, rank: 5, wins: 71, losses: 69, draws: 4, pct: 0.507, gb: 14, streak: "2연패", last10: "4승6패" },
  { teamId: 2, season: 2026, rank: 6, wins: 70, losses: 70, draws: 4, pct: 0.500, gb: 15, streak: "1연승", last10: "5승5패" },
  { teamId: 8, season: 2026, rank: 7, wins: 67, losses: 73, draws: 4, pct: 0.479, gb: 18, streak: "3연패", last10: "3승7패" },
  { teamId: 3, season: 2026, rank: 8, wins: 65, losses: 75, draws: 4, pct: 0.464, gb: 20, streak: "1연패", last10: "4승6패" },
  { teamId: 7, season: 2026, rank: 9, wins: 60, losses: 80, draws: 4, pct: 0.429, gb: 25, streak: "2연승", last10: "5승5패" },
  { teamId: 10, season: 2026, rank: 10, wins: 55, losses: 85, draws: 4, pct: 0.393, gb: 30, streak: "4연패", last10: "2승8패" },
];

type TitleCategory = "avg" | "hr" | "rbi" | "hits" | "sb" | "wins" | "era" | "so" | "saves" | "holds";

interface TitleLeader {
  rank: number;
  name: string;
  teamId: number;
  value: string;
}

const BATTER_TITLES: { id: TitleCategory; label: string; leaders: TitleLeader[] }[] = [
  { id: "avg", label: "타율", leaders: [
    { rank: 1, name: "구자욱", teamId: 8, value: ".348" },
    { rank: 2, name: "오스틴", teamId: 1, value: ".341" },
    { rank: 3, name: "김도영", teamId: 6, value: ".335" },
    { rank: 4, name: "나성범", teamId: 3, value: ".328" },
    { rank: 5, name: "이정후", teamId: 10, value: ".322" },
  ]},
  { id: "hr", label: "홈런", leaders: [
    { rank: 1, name: "오스틴", teamId: 1, value: "35" },
    { rank: 2, name: "페르난데스", teamId: 4, value: "32" },
    { rank: 3, name: "김도영", teamId: 6, value: "28" },
    { rank: 4, name: "나성범", teamId: 3, value: "25" },
    { rank: 5, name: "최형우", teamId: 6, value: "23" },
  ]},
  { id: "rbi", label: "타점", leaders: [
    { rank: 1, name: "오스틴", teamId: 1, value: "108" },
    { rank: 2, name: "김도영", teamId: 6, value: "98" },
    { rank: 3, name: "페르난데스", teamId: 4, value: "95" },
    { rank: 4, name: "구자욱", teamId: 8, value: "87" },
    { rank: 5, name: "김하성", teamId: 2, value: "82" },
  ]},
  { id: "hits", label: "안타", leaders: [
    { rank: 1, name: "구자욱", teamId: 8, value: "178" },
    { rank: 2, name: "김도영", teamId: 6, value: "172" },
    { rank: 3, name: "이정후", teamId: 10, value: "168" },
    { rank: 4, name: "오스틴", teamId: 1, value: "165" },
    { rank: 5, name: "나성범", teamId: 3, value: "158" },
  ]},
  { id: "sb", label: "도루", leaders: [
    { rank: 1, name: "김도영", teamId: 6, value: "42" },
    { rank: 2, name: "이정후", teamId: 10, value: "28" },
    { rank: 3, name: "박동원", teamId: 1, value: "22" },
    { rank: 4, name: "한석현", teamId: 7, value: "20" },
    { rank: 5, name: "김하성", teamId: 2, value: "18" },
  ]},
];

const PITCHER_TITLES: { id: TitleCategory; label: string; leaders: TitleLeader[] }[] = [
  { id: "era", label: "평균자책", leaders: [
    { rank: 1, name: "양현종", teamId: 6, value: "2.45" },
    { rank: 2, name: "안우진", teamId: 6, value: "2.68" },
    { rank: 3, name: "문동주", teamId: 9, value: "2.87" },
    { rank: 4, name: "소형준", teamId: 5, value: "3.12" },
    { rank: 5, name: "이의리", teamId: 2, value: "3.24" },
  ]},
  { id: "wins", label: "다승", leaders: [
    { rank: 1, name: "안우진", teamId: 6, value: "16" },
    { rank: 2, name: "양현종", teamId: 6, value: "15" },
    { rank: 3, name: "소형준", teamId: 5, value: "14" },
    { rank: 4, name: "문동주", teamId: 9, value: "13" },
    { rank: 5, name: "이의리", teamId: 2, value: "12" },
  ]},
  { id: "so", label: "탈삼진", leaders: [
    { rank: 1, name: "안우진", teamId: 6, value: "198" },
    { rank: 2, name: "문동주", teamId: 9, value: "185" },
    { rank: 3, name: "소형준", teamId: 5, value: "172" },
    { rank: 4, name: "이의리", teamId: 2, value: "164" },
    { rank: 5, name: "양현종", teamId: 6, value: "148" },
  ]},
  { id: "saves", label: "세이브", leaders: [
    { rank: 1, name: "정우영", teamId: 1, value: "38" },
    { rank: 2, name: "박영현", teamId: 6, value: "34" },
    { rank: 3, name: "고우석", teamId: 2, value: "31" },
    { rank: 4, name: "이승현", teamId: 8, value: "28" },
    { rank: 5, name: "조상우", teamId: 3, value: "25" },
  ]},
  { id: "holds", label: "홀드", leaders: [
    { rank: 1, name: "김진욱", teamId: 9, value: "28" },
    { rank: 2, name: "최원준", teamId: 4, value: "25" },
    { rank: 3, name: "진해수", teamId: 1, value: "22" },
    { rank: 4, name: "김재열", teamId: 5, value: "20" },
    { rank: 5, name: "임기영", teamId: 2, value: "18" },
  ]},
];

function getTeam(id: number) {
  return TEAMS.find((t) => t.id === id)!;
}

function getTeamColor(id: number) {
  return TEAMS.find((t) => t.id === id)?.colorPrimary ?? "#888";
}

function getStreakIcon(streak: string) {
  const num = parseInt(streak);
  if (streak.includes("연승") && num >= 3) return "🔥";
  if (streak.includes("연패") && num >= 3) return "❄️";
  return "";
}

type MainTab = "team" | "batter" | "pitcher";

function LeaderSection({ title, leaders }: { title: string; leaders: TitleLeader[] }) {
  return (
    <div className="glass-card p-3">
      <h3 className="text-xs font-semibold text-text-tertiary mb-2">{title}</h3>
      <div className="space-y-2">
        {leaders.map((l) => (
          <div key={l.rank} className="flex items-center gap-2">
            <span className={clsx("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold",
              l.rank === 1 ? "bg-yellow-500/20 text-yellow-400" :
              l.rank === 2 ? "bg-gray-400/20 text-gray-300" :
              l.rank === 3 ? "bg-amber-700/20 text-amber-600" :
              "bg-bg-tertiary text-text-tertiary"
            )}>
              {l.rank}
            </span>
            <PlayerAvatar name={l.name} teamId={l.teamId} photoUrl={getPlayerPhotoUrl(l.name)} size={36} />
            <span className="flex-1 text-sm text-text-primary">{l.name}</span>
            <span className="text-sm font-bold tabular-nums" style={{ color: getTeamColor(l.teamId) }}>{l.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function StandingsPage() {
  const [mainTab, setMainTab] = useState<MainTab>("team");

  return (
    <div className="mx-auto max-w-lg px-4">
      <header className="py-4">
        <h1 className="text-lg font-bold text-text-primary">순위</h1>
        <p className="text-xs text-text-secondary">2026 시즌</p>
      </header>

      {/* Main tabs */}
      <div className="flex gap-2 mb-4">
        {([
          { id: "team" as MainTab, label: "구단 순위" },
          { id: "batter" as MainTab, label: "타자 타이틀" },
          { id: "pitcher" as MainTab, label: "투수 타이틀" },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setMainTab(tab.id)}
            className={clsx(
              "flex-1 py-2 text-sm font-medium rounded-full transition-all",
              mainTab === tab.id
                ? "bg-accent text-white"
                : "bg-bg-tertiary text-text-tertiary"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Team standings */}
      {mainTab === "team" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-card overflow-hidden"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-[11px] font-semibold text-text-tertiary">
                <th className="w-8 py-2 text-center">#</th>
                <th className="py-2 text-left pl-2">팀</th>
                <th className="w-9 py-2 text-center">승</th>
                <th className="w-9 py-2 text-center">패</th>
                <th className="w-9 py-2 text-center">무</th>
                <th className="w-12 py-2 text-center">승률</th>
                <th className="w-9 py-2 text-center">차</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_STANDINGS.map((standing, i) => {
                const team = getTeam(standing.teamId);
                const isMyTeam = standing.teamId === 1;
                return (
                  <motion.tr
                    key={standing.teamId}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className={`border-b border-border/30 last:border-0 ${isMyTeam ? "bg-white/5" : ""}`}
                  >
                    <td className="py-2.5 text-center font-bold text-text-primary">{standing.rank}</td>
                    <td className="py-2.5 pl-2">
                      <div className="flex items-center gap-1.5">
                        <TeamLogo team={team} size={20} />
                        <span className="font-medium text-text-primary whitespace-nowrap">{team.shortName}</span>
                        {getStreakIcon(standing.streak) && <span className="text-xs">{getStreakIcon(standing.streak)}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 text-center tabular-nums text-text-primary">{standing.wins}</td>
                    <td className="py-2.5 text-center tabular-nums text-text-primary">{standing.losses}</td>
                    <td className="py-2.5 text-center tabular-nums text-text-secondary">{standing.draws}</td>
                    <td className="py-2.5 text-center tabular-nums font-semibold text-text-primary">{standing.pct.toFixed(3).slice(1)}</td>
                    <td className="py-2.5 text-center tabular-nums text-text-secondary">{standing.gb === 0 ? "-" : standing.gb}</td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </motion.div>
      )}

      {/* Batter titles */}
      {mainTab === "batter" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-3"
        >
          {BATTER_TITLES.map((cat) => (
            <LeaderSection key={cat.id} title={cat.label} leaders={cat.leaders} />
          ))}
        </motion.div>
      )}

      {/* Pitcher titles */}
      {mainTab === "pitcher" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-3"
        >
          {PITCHER_TITLES.map((cat) => (
            <LeaderSection key={cat.id} title={cat.label} leaders={cat.leaders} />
          ))}
        </motion.div>
      )}

      <div className="h-4" />
    </div>
  );
}
