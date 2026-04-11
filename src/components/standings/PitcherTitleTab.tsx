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

  // KBO 규정이닝: 팀경기수(144) × 1.0 = 144이닝 — 2025(확정 시즌)만 적용
  // 2026(현재 시즌c): ERA/WHIP는 최소 12이닝 (KBO 공식 규정이닝 기준)
  const qualifiedP = season === 2025
    ? realPitchers.filter((p) => Number(p.ip || 0) >= 144 || (!(p.ip) && Number(p.games || 0) >= 40))
    : realPitchers;
  const parseIP = (ip: string | number): number => {
    if (typeof ip === "number") return ip;
    const s = String(ip).trim();
    const match = s.match(/^(\d+)(?:\s+(\d+)\/(\d+))?$/);
    if (!match) return 0;
    const whole = parseInt(match[1]) || 0;
    const frac = match[2] && match[3] ? parseInt(match[2]) / parseInt(match[3]) : 0;
    return whole + frac;
  };
  const qualifiedRate = season === 2026
    ? realPitchers.filter((p) => parseIP(p.ip || 0) >= 12)
    : qualifiedP;
  const toLeader = (p: RealPitcherStat, valKey: string): TitleLeader => ({
    rank: p.rank, name: p.name, teamId: TEAM_NAME_TO_ID[p.team] ?? 0,
    value: String(p[valKey] ?? 0), playerId: (p as Record<string, unknown>).kboId as string || (p as Record<string, unknown>).playerId as string || PLAYER_PHOTO_MAP[p.name],
  });
  // 공동 순위 적용 (competition ranking)
  const sorted = (key: string, desc = true, pool = qualifiedP) => {
    const arr = [...pool].sort((a, b) => desc ? Number(b[key] || 0) - Number(a[key] || 0) : Number(a[key] || 0) - Number(b[key] || 0));
    let currentRank = 1;
    return arr.slice(0, 20).map((p, i) => {
      if (i > 0) {
        const prev = arr[i - 1];
        if (Number(p[key] || 0) !== Number(prev[key] || 0)) {
          currentRank = i + 1;
        }
      }
      return { ...toLeader(p, key), rank: currentRank };
    });
  };
  // 세이브/홀드는 규정이닝 무관 → 전체 투수에서 정렬
  // 2025(확정 시즌)만 정적 fallback 허용, 2026은 실제 데이터만 표시
  const sortedAll = (key: string) => {
    const all = [...realPitchers].sort((a, b) => Number(b[key] || 0) - Number(a[key] || 0))
      .filter((p) => Number(p[key] || 0) > 0);
    let currentRank = 1;
    const ranked = all.slice(0, 20).map((p, i) => {
      if (i > 0) {
        const prev = all[i - 1];
        if (Number(p[key] || 0) !== Number(prev[key] || 0)) {
          currentRank = i + 1;
        }
      }
      return { ...toLeader(p, key), rank: currentRank };
    });
    // 데이터 부족 시: 2025만 정적 fallback, 2026은 빈 배열 반환 (거짓 데이터 방지)
    if (ranked.length === 0) {
      if (season === 2025) {
        const fallback = PITCHER_TITLES.find(t => t.id === key);
        return fallback?.leaders ?? ranked;
      }
      return ranked;
    }
    return ranked;
  };
  const eraTop = sorted("era", false, qualifiedRate);
  const whipTop = sorted("whip", false, qualifiedRate.filter((p) => p.whip));

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
        cat.leaders.length > 0 ? (
          <LeaderSection key={cat.id} title={`${cat.label} (${season})`} leaders={cat.leaders} myTeamId={myTeamId} favoriteNames={favoriteNames} />
        ) : (
          <div key={cat.id} className="glass-card p-4">
            <h3 className="text-base font-semibold text-text-tertiary mb-2">{cat.label} ({season})</h3>
            <p className="text-sm text-text-tertiary text-center py-4">⚔️ 시즌 초반 — 데이터 축적 중</p>
          </div>
        )
      ))}
    </motion.div>
  );
}
