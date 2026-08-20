"use client";
import { ChevronLeft, Check } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
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
import { getKSTToday } from "@/lib/utils/date-kst";
import BatterTitleTab from "@/components/standings/BatterTitleTab";
import PitcherTitleTab from "@/components/standings/PitcherTitleTab";
import DailyAnalysisCard from "@/components/standings/DailyAnalysisCard";

// 순위표 팀명 아래 '오늘 결과' 미니 인디케이터 (텍스트 → 아이콘, 회장님 요청 2026-06-25).
// "reflected" → 오늘 경기 결과가 순위에 반영됨 → 초록 체크.
// "live"      → 경기 시작했으나 아직 반영 전(경기중/종료직후) → 반짝이는 초록 점.
// "pending"/null → 경기 시작 전 또는 오늘 경기 없음 → 표시 없음.
type TodayState = "reflected" | "live" | "pending";
function TodayStatus({ state }: { state: TodayState | null }) {
  if (state === "reflected") {
    return (
      <span className="inline-flex items-center shrink-0" title="오늘 결과 반영됨" aria-label="오늘 결과 반영됨">
        <Check size={13} strokeWidth={3} className="text-accent-green" />
      </span>
    );
  }
  if (state === "live") {
    return (
      <span className="relative inline-flex h-2 w-2 shrink-0" title="경기 진행 중 (반영 전)" aria-label="경기 진행 중">
        <span className="absolute inline-flex h-full w-full rounded-full bg-accent-green opacity-60 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-green" />
      </span>
    );
  }
  return null; // pending(경기 시작 전) / 오늘 경기 없음 → 표시 없음
}

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
  // 팀별 '오늘 결과' 상태: reflected=반영됨, live=경기중(반영 전), pending=경기 시작 전, 미존재=오늘 경기 없음
  const [statusMap, setStatusMap] = useState<Map<number, TodayState>>(new Map());

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

  // '오늘 결과 반영' 판정:
  // baseline = 오늘(KST) 날짜의 daily_standings_snapshot (01:00 KST cron이 저장 → 오늘 경기 이전 누적 경기수)
  // 현재 = /api/standings 의 팀별 누적 경기수(승+패+무)
  // 오늘 final 경기수만큼 누적이 늘었으면(현재 >= baseline + 오늘 final) → 반영됨.
  // baseline 부재/오늘 경기 없음 등 불확실 시 보수적으로 '반영 전'(false)로 둔다.
  useEffect(() => {
    if (season !== 2026) { setStatusMap(new Map()); return; } // eslint-disable-line react-hooks/set-state-in-effect
    const today = getKSTToday().replace(/-/g, "");
    Promise.all([
      fetch(`/api/games?date=${today}`, { cache: "no-store" }).then(r => r.json()).catch(() => null),
      fetch("/api/standings", { cache: "no-store" }).then(r => r.json()).catch(() => null),
      fetch(`/api/standings-snapshot?date=${today}`, { cache: "no-store" }).then(r => r.json()).catch(() => null),
    ]).then(([gamesData, standingsData, snapshotData]) => {
      // 오늘 팀별 final 경기수
      const todayFinals = new Map<number, number>();
      if (Array.isArray(gamesData?.games)) {
        for (const g of gamesData.games as { homeTeamId?: number; awayTeamId?: number; status?: string }[]) {
          if (g.status !== "final") continue;
          if (g.homeTeamId) todayFinals.set(g.homeTeamId, (todayFinals.get(g.homeTeamId) ?? 0) + 1);
          if (g.awayTeamId) todayFinals.set(g.awayTeamId, (todayFinals.get(g.awayTeamId) ?? 0) + 1);
        }
      }
      // 오늘 경기가 있는 팀 (scheduled/live/final/cancelled 모두 — 표시 여부 판단용)
      const teamsWithGameToday = new Set<number>();
      // 경기가 시작된 팀 (live=경기중, final=종료). 반영 전이면 '반짝이는 점' 대상.
      const startedTeams = new Set<number>();
      if (Array.isArray(gamesData?.games)) {
        for (const g of gamesData.games as { homeTeamId?: number; awayTeamId?: number; status?: string }[]) {
          if (g.homeTeamId) teamsWithGameToday.add(g.homeTeamId);
          if (g.awayTeamId) teamsWithGameToday.add(g.awayTeamId);
          if (g.status === "live" || g.status === "final") {
            if (g.homeTeamId) startedTeams.add(g.homeTeamId);
            if (g.awayTeamId) startedTeams.add(g.awayTeamId);
          }
        }
      }
      // 현재 누적 경기수 (승+패+무)
      const currentGames = new Map<number, number>();
      if (Array.isArray(standingsData?.standings)) {
        for (const s of standingsData.standings as RawStanding[]) {
          const id = TEAM_NAME_TO_ID[s.teamName];
          if (id) currentGames.set(id, (s.wins ?? 0) + (s.losses ?? 0) + (s.draws ?? 0));
        }
      }
      // baseline 누적 경기수 (오늘 스냅샷)
      const baselineGames = new Map<number, number>();
      if (Array.isArray(snapshotData?.teams)) {
        for (const t of snapshotData.teams as { teamId: number; games: number }[]) {
          baselineGames.set(t.teamId, t.games);
        }
      }
      const m = new Map<number, TodayState>();
      for (const teamId of teamsWithGameToday) {
        const finals = todayFinals.get(teamId) ?? 0;
        let reflected = false;
        if (finals > 0) {
          const cur = currentGames.get(teamId);
          const base = baselineGames.get(teamId);
          // baseline 또는 현재값 부재 시 보수적으로 반영 전 처리
          reflected = cur != null && base != null && cur - base >= finals;
        }
        if (reflected) m.set(teamId, "reflected");
        else if (startedTeams.has(teamId)) m.set(teamId, "live"); // 경기중/종료직후, 반영 전
        else m.set(teamId, "pending"); // 경기 시작 전(또는 취소) → 표시 없음
      }
      setStatusMap(m);
    });
  }, [season]);

  const standings = season === 2025 ? STANDINGS_2025 : (realStandings ?? MOCK_STANDINGS);
  // 오늘 경기가 시작된 팀이 하나라도 있을 때만 '금일경기 반영여부' 안내를 노출.
  // 00시가 지나 새 날이 시작되면 그날 경기는 전부 '경기 시작 전'(pending) → 안내/아이콘 모두 사라짐.
  const hasTodayStatus = season === 2026 && Array.from(statusMap.values()).some((s) => s === "reflected" || s === "live");
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
  const goBack = useSafeBack("/");
  const [mainTab, setMainTab] = useState<MainTab>("team");

  return (
    <div className="mx-auto max-w-lg px-5">
      <div className="sticky top-0 z-30 border-b -mx-5 px-5 bg-bg-primary" style={{ borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)', paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <header className="min-h-[44px] flex items-center gap-3">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors"><ChevronLeft size={24} /></button>
          <h1 className="text-lg font-bold text-text-primary tracking-tight flex-1">순위</h1>
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
          <table className="w-full text-[11px] min-[360px]:text-xs sm:text-base table-fixed">
            {hasTodayStatus && (
              <caption className="caption-top px-2 pt-2 pb-1 text-left">
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] sm:text-xs font-normal text-text-tertiary">
                  <span>금일경기 반영여부</span>
                  <span className="inline-flex items-center gap-0.5">
                    <Check size={11} strokeWidth={3} className="text-accent-green" />반영됨
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent-green" />경기중
                  </span>
                </span>
              </caption>
            )}
            <colgroup>
              <col className="w-5 sm:w-6" />
              <col />
              <col className="w-7 min-[360px]:w-9 sm:w-10" />
              <col className="w-5 min-[360px]:w-6 sm:w-10" />
              <col className="w-5 min-[360px]:w-6 sm:w-10" />
              <col className="w-4 min-[360px]:w-5 sm:w-8" />
              <col className="w-7 min-[360px]:w-9 sm:w-12" />
              <col className="w-8 min-[360px]:w-9 sm:w-10" />
              <col className="w-7 min-[360px]:w-9 sm:w-11" />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-[11px] min-[360px]:text-xs sm:text-base font-semibold text-text-tertiary">
                <th className="py-2 text-center">#</th>
                <th className="py-2 text-left pl-2">팀</th>
                <th className="py-2 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 whitespace-nowrap">경기</th>
                <th className="py-2 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2">승</th>
                <th className="py-2 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2">패</th>
                <th className="py-2 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2">무</th>
                <th className="py-2 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 whitespace-nowrap">승률</th>
                <th className="py-2 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2">차</th>
                <th className="py-2 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 whitespace-nowrap">연속</th>
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
                      <div className="flex items-center gap-1 sm:gap-2 min-w-0">
                        <TeamLogo team={team} size={20} className="shrink-0 !h-5 !w-5 min-[360px]:!h-6 min-[360px]:!w-6 sm:!h-7 sm:!w-7" />
                        <span className="font-medium text-text-primary truncate">{team.shortName}</span>
                        {season === 2026 && <TodayStatus state={statusMap.get(standing.teamId) ?? null} />}
                        {getStreakIcon(standing.streak) && <span className="hidden min-[360px]:inline-block text-sm sm:text-base shrink-0">{getStreakIcon(standing.streak)}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 tabular-nums text-text-secondary">{standing.wins + standing.losses + standing.draws}</td>
                    <td className="py-2.5 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 tabular-nums text-text-primary">{standing.wins}</td>
                    <td className="py-2.5 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 tabular-nums text-text-primary">{standing.losses}</td>
                    <td className="py-2.5 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 tabular-nums text-text-secondary">{standing.draws}</td>
                    <td className="py-2.5 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 tabular-nums font-semibold text-text-primary">{standing.pct >= 1 ? "1.000" : standing.pct.toFixed(3).slice(1)}</td>
                    <td className="py-2.5 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 tabular-nums text-text-secondary">{standing.gb === 0 ? "-" : standing.gb}</td>
                    <td className="py-2.5 text-right pr-0.5 min-[360px]:pr-1 sm:pr-2 tabular-nums text-text-primary whitespace-nowrap">
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
