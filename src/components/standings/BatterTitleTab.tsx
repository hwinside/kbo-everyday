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

  // KBO 규정타석: 팀경기수 × 3.1 — API가 KBO HRA_RT 페이지 기준 qualifiedRate 플래그 제공
  const qualified = season === 2025
    ? realBatters.filter((b) => Number(b.pa || 0) >= 446 || (!(b.pa) && Number(b.games || 0) >= 120))
    : realBatters;
  // 2026: KBO 공식 규정타석 충족 선수만 (API qualifiedRate=1 기준)
  const qualifiedRate = season === 2026
    ? realBatters.filter((b) => b.qualifiedRate === 1)
    : qualified;
  const toLeader = (b: RealBatterStat, valKey: string): TitleLeader => ({
    rank: b.rank, name: b.name, teamId: TEAM_NAME_TO_ID[b.team] ?? 0,
    value: String(b[valKey] ?? 0), playerId: (b as Record<string, unknown>).kboId as string || (b as Record<string, unknown>).playerId as string || PLAYER_PHOTO_MAP[b.name],
  });
  // 공동 순위 적용 (competition ranking)
  const sorted = (key: string, desc = true, pool = qualified) => {
    const arr = [...pool].sort((a, b) => desc ? Number(b[key] || 0) - Number(a[key] || 0) : Number(a[key] || 0) - Number(b[key] || 0));
    let currentRank = 1;
    return arr.slice(0, 20).map((b, i) => {
      if (i > 0) {
        const prev = arr[i - 1];
        if (Number(b[key] || 0) !== Number(prev[key] || 0)) {
          currentRank = i + 1;
        }
      }
      return { ...toLeader(b, key), rank: currentRank };
    });
  };
  const avgTop = sorted("avg", true, qualifiedRate);
  const opsTop = sorted("ops", true, qualifiedRate.filter((b) => b.ops));
  const obpTop = sorted("obp", true, qualifiedRate.filter((b) => b.obp));
  const slgTop = sorted("slg", true, qualifiedRate.filter((b) => b.slg));

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
