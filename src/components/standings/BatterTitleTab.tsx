"use client";

import { motion } from "framer-motion";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { TEAM_NAME_TO_ID, type RealBatterStat, type TitleLeader } from "@/lib/constants/standings-data";
import LeaderSection from "./LeaderSection";

interface BatterTitleTabProps {
  realBatters: RealBatterStat[] | null;
  myTeamId: number | null;
  favoriteNames: Set<string>;
  season?: number;
}

export default function BatterTitleTab({ realBatters, myTeamId, favoriteNames, season = 2026 }: BatterTitleTabProps) {
  if (!realBatters) return <div className="text-center py-8 text-text-tertiary text-sm">{season} 시즌 데이터 로딩 중...</div>;
  if (realBatters.length === 0) return <div className="text-center py-8 text-text-tertiary text-sm">시즌 데이터가 아직 없습니다</div>;

  // KBO 규정타석: 팀경기수(144) × 3.1 = 446타석
  const qualified = realBatters.filter((b) => Number(b.pa || 0) >= 446 || (!(b.pa) && Number(b.games || 0) >= 120));
  const toLeader = (b: RealBatterStat, valKey: string): TitleLeader => ({
    rank: b.rank, name: b.name, teamId: TEAM_NAME_TO_ID[b.team] ?? 0,
    value: String(b[valKey] ?? 0), playerId: PLAYER_PHOTO_MAP[b.name],
  });
  const sorted = (key: string, desc = true) =>
    [...qualified].sort((a, b) => desc ? Number(b[key] || 0) - Number(a[key] || 0) : Number(a[key] || 0) - Number(b[key] || 0))
      .slice(0, 20).map((b, i) => ({ ...toLeader(b, key), rank: i + 1 }));
  const avgTop = [...qualified].sort((a, b) => Number(b.avg || 0) - Number(a.avg || 0)).slice(0, 20).map((b, i) => ({ ...toLeader(b, "avg"), rank: i + 1 }));
  const opsTop = [...qualified].filter((b) => b.ops).sort((a, b) => Number(b.ops || 0) - Number(a.ops || 0)).slice(0, 20).map((b, i) => ({ ...toLeader(b, "ops"), rank: i + 1 }));
  const obpTop = [...qualified].filter((b) => b.obp).sort((a, b) => Number(b.obp || 0) - Number(a.obp || 0)).slice(0, 20).map((b, i) => ({ ...toLeader(b, "obp"), rank: i + 1 }));
  const slgTop = [...qualified].filter((b) => b.slg).sort((a, b) => Number(b.slg || 0) - Number(a.slg || 0)).slice(0, 20).map((b, i) => ({ ...toLeader(b, "slg"), rank: i + 1 }));

  const categories = [
    { id: "avg", label: "타율", leaders: avgTop },
    { id: "hr", label: "홈런", leaders: sorted("hr") },
    { id: "rbi", label: "타점", leaders: sorted("rbi") },
    { id: "hits", label: "안타", leaders: sorted("hits") },
    { id: "sb", label: "도루", leaders: sorted("sb") },
    ...(opsTop.length > 0 ? [
      { id: "ops", label: "OPS", leaders: opsTop },
      { id: "obp", label: "출루율", leaders: obpTop },
      { id: "slg", label: "장타율", leaders: slgTop },
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
