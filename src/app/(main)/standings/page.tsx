"use client";
import { ChevronLeft } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { clsx } from "clsx";
import { TEAMS, getTeamBgColor } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getMyTeamId } from "@/lib/store/myteam";
import { getFavoritePlayers } from "@/lib/store/favorites";
import TeamLogo from "@/components/ui/TeamLogo";
import type { TeamStanding } from "@/lib/types";
import { STANDINGS_2025, MOCK_STANDINGS, TEAM_NAME_TO_ID, type RawStanding, type RealBatterStat, type RealPitcherStat, type MainTab } from "@/lib/constants/standings-data";
import { getTeam, getStreakIcon } from "@/lib/utils/standings";
import BatterTitleTab from "@/components/standings/BatterTitleTab";
import PitcherTitleTab from "@/components/standings/PitcherTitleTab";
import DailyAnalysisCard from "@/components/standings/DailyAnalysisCard";

export default function StandingsPage() {
  const { profile } = useAuth();
  const myTeamId = profile?.team_id ?? getMyTeamId();

  const favoriteNames = (() => {
    const dbFavs = profile?.favorite_players as { name?: string }[] | undefined;
    const favs = dbFavs?.length ? dbFavs : getFavoritePlayers();
    return new Set(favs.map((f) => f.name || "").filter(Boolean));
  })();

  const [realStandings, setRealStandings] = useState<TeamStanding[] | null>(null);
  const [season, setSeason] = useState<2025 | 2026>(2026);

  const [dailyAnalysis, setDailyAnalysis] = useState<{ date: string; analysis: Record<string, { copy: string | null; lastUpdated?: string }> } | null>(null);
  const [dailyAnalysisLoading, setDailyAnalysisLoading] = useState(true);

  useEffect(() => {
    if (season !== 2026) { setDailyAnalysis(null); setDailyAnalysisLoading(false); return; }
    setDailyAnalysisLoading(true);
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
    fetch(`/api/daily-analysis?date=${today}&t=${Date.now()}`, { cache: "no-store" })
      .then(r => r.json())
      .then(data => { if (data.analysis) setDailyAnalysis(data); })
      .catch(() => {})
      .finally(() => setDailyAnalysisLoading(false));
  }, [season]);

  useEffect(() => {
    // 2025 시즌은 확정 데이터 사용, API fetch 불필요
    if (season !== 2026) { setRealStandings(null); return; } // eslint-disable-line react-hooks/set-state-in-effect
    fetch("/api/standings", { cache: "no-store" })
      .then(r => r.json())
      .then(data => {
        if (data.standings?.length) {
          // API 원본 ranking 우선 사용, 없으면 승률 기반 공동순위 계산
          const hasRanking = data.standings.some((s: RawStanding & { ranking?: number }) => s.ranking != null && s.ranking > 0);
          let currentRank = 1;
          const mapped: TeamStanding[] = data.standings.map((s: RawStanding & { ranking?: number }, i: number) => {
            let rank: number;
            if (hasRanking) {
              rank = s.ranking!;
            } else {
              if (i > 0) {
                const prev = data.standings[i - 1] as RawStanding;
                if (s.winRate !== prev.winRate) {
                  currentRank = i + 1;
                }
              }
              rank = currentRank;
            }
            // 네이버 API 원본 "3승"/"1패"/"2무" 그대로 사용. 패턴 불일치 시 빈 값.
            const streakRaw = s.continuousGameResult?.trim() || "";
            const streakNormalized = /^\d+[승패무]$/.test(streakRaw) ? streakRaw : "";
            return {
              teamId: TEAM_NAME_TO_ID[s.teamName] ?? 0,
              season: 2026,
              rank,
              wins: s.wins,
              losses: s.losses,
              draws: s.draws,
              pct: s.winRate,
              gb: s.gamesBehind,
              streak: streakNormalized,
              last10: "",
            };
          });
          setRealStandings(mapped);
        }
      })
      .catch(() => {});
  }, [season]);

  const standings = season === 2025 ? STANDINGS_2025 : (realStandings ?? MOCK_STANDINGS);
  const [realBatters, setRealBatters] = useState<RealBatterStat[] | null>(null);
  const [realPitchers, setRealPitchers] = useState<RealPitcherStat[] | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRealBatters(null); setRealPitchers(null);
    fetch(`/api/stats?type=batter&season=${season}`)
      .then(r => r.json())
      // eslint-disable-next-line react-hooks/set-state-in-effect
      .then(d => d.stats?.length && setRealBatters(d.stats))
      .catch(() => {});
    fetch(`/api/stats?type=pitcher&season=${season}`)
      .then(r => r.json())
      // eslint-disable-next-line react-hooks/set-state-in-effect
      .then(d => d.stats?.length && setRealPitchers(d.stats))
      .catch(() => {});
  }, [season]);
  const router = useRouter();
  const [mainTab, setMainTab] = useState<MainTab>("team");

  return (
    <div className="mx-auto max-w-lg px-5">
      <div className="border-b -mx-5 px-5" style={{ borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)' }}>
        <header className="py-3 flex items-center gap-3">
          <button onClick={() => router.back()} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors"><ChevronLeft size={24} /></button>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight flex-1">순위</h1>
          <HeaderProfileLink />
        </header>
      </div>

      {/* Season + Main tabs */}
      <div className="flex items-center gap-2 mt-2">
      {([2025, 2026] as const).map(y => (
        <button
          key={y}
          onClick={() => setSeason(y)}
          className={clsx(
            "px-3 py-1 rounded-full text-xs font-semibold transition-all",
            season === y ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
          )}
        >
          {y} 시즌
        </button>
      ))}
      </div>
      <div className="flex gap-2 mt-2 mb-3">
      {([
        { id: "team" as MainTab, label: "구단 순위" },
        { id: "batter" as MainTab, label: "타자 타이틀" },
        { id: "pitcher" as MainTab, label: "투수 타이틀" },
      ]).map((tab) => (
        <button
          key={tab.id}
          onClick={() => setMainTab(tab.id)}
          className={clsx(
            "px-4 py-1.5 text-xs font-semibold rounded-full transition-all",
            mainTab === tab.id
              ? "bg-accent text-white"
              : "bg-bg-tertiary text-text-secondary"
          )}
        >
          {tab.label}
        </button>
      ))}
      </div>

      {(<>
      {/* Team standings */}
      {mainTab === "team" && season === 2026 && (
        <DailyAnalysisCard type="standings" date={dailyAnalysis?.date ?? null} analysis={dailyAnalysis?.analysis ?? null} loading={dailyAnalysisLoading} />
      )}
      {mainTab === "team" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-card overflow-hidden"
        >
          <table className="w-full text-sm sm:text-base table-fixed">
            <colgroup>
              <col className="w-6" />
              <col />
              <col className="w-7 sm:w-10" />
              <col className="w-7 sm:w-10" />
              <col className="w-6 sm:w-8" />
              <col className="w-9 sm:w-12" />
              <col className="w-9 sm:w-10" />
              <col className="w-9 sm:w-11" />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-sm sm:text-base font-semibold text-text-tertiary">
                <th className="py-2 text-center">#</th>
                <th className="py-2 text-left pl-2">팀</th>
                <th className="py-2 text-right pr-1 sm:pr-2">승</th>
                <th className="py-2 text-right pr-1 sm:pr-2">패</th>
                <th className="py-2 text-right pr-1 sm:pr-2">무</th>
                <th className="py-2 text-right pr-1 sm:pr-2">승률</th>
                <th className="py-2 text-right pr-1 sm:pr-2">차</th>
                <th className="py-2 text-right pr-1 sm:pr-2">연속</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((standing, i) => {
                const team = getTeam(standing.teamId);
                const isMyTeam = myTeamId !== null && standing.teamId === myTeamId;
                return (
                  <motion.tr
                    key={standing.teamId}
                    onClick={() => { const t = TEAMS.find(t => t.id === standing.teamId); if (t) router.push(`/teams/${t.slug}`); }}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className={`border-b border-border/30 last:border-0 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5`}
                    style={isMyTeam ? {
                      backgroundColor: `${getTeamBgColor(team)}18`,
                      borderLeft: `3px solid ${getTeamBgColor(team)}`,
                    } : undefined}
                  >
                    <td className="py-2.5 text-center font-bold text-text-primary">{standing.rank}</td>
                    <td className="py-2.5 pl-2">
                      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                        <TeamLogo team={team} size={24} className="sm:!h-7 sm:!w-7" />
                        <span className="font-medium text-text-primary truncate">{team.shortName}</span>
                        {getStreakIcon(standing.streak) && <span className="hidden min-[360px]:inline-block text-sm sm:text-base shrink-0">{getStreakIcon(standing.streak)}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 text-right pr-1 sm:pr-2 tabular-nums text-text-primary">{standing.wins}</td>
                    <td className="py-2.5 text-right pr-1 sm:pr-2 tabular-nums text-text-primary">{standing.losses}</td>
                    <td className="py-2.5 text-right pr-1 sm:pr-2 tabular-nums text-text-secondary">{standing.draws}</td>
                    <td className="py-2.5 text-right pr-1 sm:pr-2 tabular-nums font-semibold text-text-primary">{standing.pct >= 1 ? "1.000" : standing.pct.toFixed(3).slice(1)}</td>
                    <td className="py-2.5 text-right pr-1 sm:pr-2 tabular-nums text-text-secondary">{standing.gb === 0 ? "-" : standing.gb}</td>
                    <td className="py-2.5 text-right pr-1 sm:pr-2 tabular-nums text-text-primary">
                      {standing.streak || <span className="text-text-secondary">-</span>}
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </motion.div>
      )}

      {/* Batter titles */}
      {mainTab === "batter" && season === 2026 && (
        <DailyAnalysisCard type="batter_titles" date={dailyAnalysis?.date ?? null} analysis={dailyAnalysis?.analysis ?? null} loading={dailyAnalysisLoading} />
      )}
      {mainTab === "batter" && (
        <BatterTitleTab realBatters={realBatters} myTeamId={myTeamId} favoriteNames={favoriteNames} season={season} />
      )}

      {/* Pitcher titles */}
      {mainTab === "pitcher" && season === 2026 && (
        <DailyAnalysisCard type="pitcher_titles" date={dailyAnalysis?.date ?? null} analysis={dailyAnalysis?.analysis ?? null} loading={dailyAnalysisLoading} />
      )}
      {mainTab === "pitcher" && (
        <PitcherTitleTab realPitchers={realPitchers} myTeamId={myTeamId} favoriteNames={favoriteNames} season={season} />
      )}

      </>)}
      <div className="h-4" />
    </div>
  );
}
