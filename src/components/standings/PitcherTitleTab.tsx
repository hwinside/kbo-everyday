"use client";

import { motion } from "framer-motion";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { TEAM_NAME_TO_ID, PITCHER_TITLES, type RealPitcherStat, type TitleLeader } from "@/lib/constants/standings-data";
import LeaderSection from "./LeaderSection";

interface PitcherTitleTabProps {
  realPitchers: RealPitcherStat[] | null;
  myTeamId: number | null;
  favoriteNames: Set<string>;
  season?: number;
}

export default function PitcherTitleTab({ realPitchers, myTeamId, favoriteNames, season = 2026 }: PitcherTitleTabProps) {
  if (!realPitchers) return <div className="text-center py-8 text-text-tertiary text-sm">{season} 시즌 데이터 로딩 중...</div>;
  if (realPitchers.length === 0) return <div className="text-center py-8 text-text-tertiary text-sm">시즌 데이터가 아직 없습니다</div>;

  // KBO 규정이닝: 팀경기수(144) × 1.0 = 144이닝
  const qualifiedP = realPitchers.filter((p) => Number(p.ip || 0) >= 144 || (!(p.ip) && Number(p.games || 0) >= 40));
  const toLeader = (p: RealPitcherStat, valKey: string): TitleLeader => ({
    rank: p.rank, name: p.name, teamId: TEAM_NAME_TO_ID[p.team] ?? 0,
    value: String(p[valKey] ?? 0), playerId: PLAYER_PHOTO_MAP[p.name],
  });
  const sorted = (key: string, desc = true) =>
    [...qualifiedP].sort((a, b) => desc ? Number(b[key] || 0) - Number(a[key] || 0) : Number(a[key] || 0) - Number(b[key] || 0))
      .slice(0, 20).map((p, i) => ({ ...toLeader(p, key), rank: i + 1 }));
  // 세이브/홀드는 규정이닝 무관 → 전체 투수에서 정렬, 의미있는 데이터 없으면 정적 데이터 fallback
  const sortedAll = (key: string) => {
    const all = [...realPitchers].sort((a, b) => Number(b[key] || 0) - Number(a[key] || 0))
      .slice(0, 20).map((p, i) => ({ ...toLeader(p, key), rank: i + 1 }));
    // 1위가 0이면 데이터 부족 → 정적 데이터 사용
    if (all.length === 0 || Number(all[0].value) === 0) {
      const fallback = PITCHER_TITLES.find(t => t.id === key);
      return fallback?.leaders ?? all;
    }
    return all;
  };
  const eraTop = [...qualifiedP].sort((a, b) => Number(a.era || 99) - Number(b.era || 99)).slice(0, 20).map((p, i) => ({ ...toLeader(p, "era"), rank: i + 1 }));
  const whipTop = [...qualifiedP].filter((p) => p.whip).sort((a, b) => Number(a.whip || 99) - Number(b.whip || 99)).slice(0, 20).map((p, i) => ({ ...toLeader(p, "whip"), rank: i + 1 }));

  const categories = [
    { id: "era", label: "평균자책", leaders: eraTop },
    { id: "wins", label: "승리", leaders: sorted("wins") },
    { id: "so", label: "탈삼진", leaders: sorted("so") },
    { id: "saves", label: "세이브", leaders: sortedAll("saves") },
    { id: "holds", label: "홀드", leaders: sortedAll("holds") },
    ...(whipTop.length > 0 ? [
      { id: "whip", label: "WHIP", leaders: whipTop },
    ] : []),
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      {categories.map((cat) => (
        <LeaderSection key={cat.id} title={`${cat.label} (${season})`} leaders={cat.leaders} myTeamId={myTeamId} favoriteNames={favoriteNames} />
      ))}
    </motion.div>
  );
}
