"use client";
import { ChevronLeft } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { clsx } from "clsx";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getMyTeamId } from "@/lib/store/myteam";
import { getFavoritePlayers } from "@/lib/store/favorites";
import TeamLogo from "@/components/ui/TeamLogo";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl, PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import type { TeamStanding } from "@/lib/types";

interface RawStanding {
  teamName: string;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  gamesBehind: number;
}

interface RealBatterStat {
  name: string;
  team: string;
  rank: number;
  pa?: number;
  games?: number;
  avg?: string;
  hr?: string;
  rbi?: string;
  hits?: string;
  sb?: string;
  ops?: string;
  obp?: string;
  slg?: string;
  [key: string]: string | number | undefined;
}

interface RealPitcherStat {
  name: string;
  team: string;
  rank: number;
  ip?: number;
  games?: number;
  era?: string;
  wins?: string;
  so?: string;
  saves?: string;
  holds?: string;
  whip?: string;
  [key: string]: string | number | undefined;
}

const MOCK_STANDINGS: TeamStanding[] = [
  { teamId: 7, season: 2026, rank: 1, wins: 85, losses: 56, draws: 3, pct: 0.603, gb: 0, streak: "3연승", last10: "7승3패" },
  { teamId: 9, season: 2026, rank: 2, wins: 83, losses: 57, draws: 4, pct: 0.593, gb: 1.5, streak: "2연승", last10: "6승4패" },
  { teamId: 4, season: 2026, rank: 3, wins: 75, losses: 64, draws: 5, pct: 0.536, gb: 9.5, streak: "1연패", last10: "5승5패" },
  { teamId: 6, season: 2026, rank: 4, wins: 73, losses: 67, draws: 4, pct: 0.521, gb: 12, streak: "1연승", last10: "6승4패" },
  { teamId: 5, season: 2026, rank: 5, wins: 71, losses: 69, draws: 4, pct: 0.507, gb: 14, streak: "2연패", last10: "4승6패" },
  { teamId: 2, season: 2026, rank: 6, wins: 70, losses: 70, draws: 4, pct: 0.500, gb: 15, streak: "1연승", last10: "5승5패" },
  { teamId: 8, season: 2026, rank: 7, wins: 67, losses: 73, draws: 4, pct: 0.479, gb: 18, streak: "3연패", last10: "3승7패" },
  { teamId: 3, season: 2026, rank: 8, wins: 65, losses: 75, draws: 4, pct: 0.464, gb: 20, streak: "1연패", last10: "4승6패" },
  { teamId: 1, season: 2026, rank: 9, wins: 60, losses: 80, draws: 4, pct: 0.429, gb: 25, streak: "2연승", last10: "5승5패" },
  { teamId: 10, season: 2026, rank: 10, wins: 55, losses: 85, draws: 4, pct: 0.393, gb: 30, streak: "4연패", last10: "2승8패" },
];

type TitleCategory = "avg" | "hr" | "rbi" | "hits" | "sb" | "wins" | "era" | "so" | "saves" | "holds";

interface TitleLeader {
  rank: number;
  name: string;
  teamId: number;
  playerId?: string;
  value: string;
}

const BATTER_TITLES: { id: TitleCategory; label: string; leaders: TitleLeader[] }[] = [
  { id: "avg", label: "타율", leaders: [
    { rank: 1, name: "구자욱", teamId: 8, value: ".348", playerId: "62404" },
    { rank: 2, name: "오스틴", teamId: 1, value: ".341", playerId: "53123" },
    { rank: 3, name: "김도영", teamId: 6, value: ".335", playerId: "52605" },
    { rank: 4, name: "나성범", teamId: 3, value: ".328", playerId: "62947" },
    { rank: 5, name: "이정후", teamId: 10, value: ".322", playerId: "67341" },
  ]},
  { id: "hr", label: "홈런", leaders: [
    { rank: 1, name: "오스틴", teamId: 1, value: "35", playerId: "53123" },
    { rank: 2, name: "페르난데스", teamId: 4, value: "32", playerId: "54400" },
    { rank: 3, name: "김도영", teamId: 6, value: "28", playerId: "52605" },
    { rank: 4, name: "나성범", teamId: 3, value: "25", playerId: "62947" },
    { rank: 5, name: "최형우", teamId: 6, value: "23", playerId: "72443" },
  ]},
  { id: "rbi", label: "타점", leaders: [
    { rank: 1, name: "오스틴", teamId: 1, value: "108", playerId: "53123" },
    { rank: 2, name: "김도영", teamId: 6, value: "98", playerId: "52605" },
    { rank: 3, name: "페르난데스", teamId: 4, value: "95", playerId: "54400" },
    { rank: 4, name: "구자욱", teamId: 8, value: "87", playerId: "62404" },
    { rank: 5, name: "김하성", teamId: 2, value: "82", playerId: "64300" },
  ]},
  { id: "hits", label: "안타", leaders: [
    { rank: 1, name: "구자욱", teamId: 8, value: "178", playerId: "62404" },
    { rank: 2, name: "김도영", teamId: 6, value: "172", playerId: "52605" },
    { rank: 3, name: "이정후", teamId: 10, value: "168", playerId: "67341" },
    { rank: 4, name: "오스틴", teamId: 1, value: "165", playerId: "53123" },
    { rank: 5, name: "나성범", teamId: 3, value: "158", playerId: "62947" },
  ]},
  { id: "sb", label: "도루", leaders: [
    { rank: 1, name: "김도영", teamId: 6, value: "42", playerId: "52605" },
    { rank: 2, name: "이정후", teamId: 10, value: "28", playerId: "67341" },
    { rank: 3, name: "박동원", teamId: 1, value: "22", playerId: "76305" },
    { rank: 4, name: "한석현", teamId: 7, value: "20", playerId: "51897" },
    { rank: 5, name: "김하성", teamId: 2, value: "18", playerId: "64300" },
  ]},
];

const PITCHER_TITLES: { id: TitleCategory; label: string; leaders: TitleLeader[] }[] = [
  { id: "era", label: "평균자책", leaders: [
    { rank: 1, name: "양현종", teamId: 6, value: "2.45", playerId: "75645" },
    { rank: 2, name: "안우진", teamId: 6, value: "2.68", playerId: "68341" },
    { rank: 3, name: "문동주", teamId: 9, value: "2.87", playerId: "51344" },
    { rank: 4, name: "소형준", teamId: 5, value: "3.12", playerId: "50662" },
    { rank: 5, name: "이의리", teamId: 2, value: "3.24", playerId: "51648" },
  ]},
  { id: "wins", label: "다승", leaders: [
    { rank: 1, name: "안우진", teamId: 6, value: "16", playerId: "68341" },
    { rank: 2, name: "양현종", teamId: 6, value: "15", playerId: "75645" },
    { rank: 3, name: "소형준", teamId: 5, value: "14", playerId: "50662" },
    { rank: 4, name: "문동주", teamId: 9, value: "13", playerId: "51344" },
    { rank: 5, name: "이의리", teamId: 2, value: "12", playerId: "51648" },
  ]},
  { id: "so", label: "탈삼진", leaders: [
    { rank: 1, name: "안우진", teamId: 6, value: "198", playerId: "68341" },
    { rank: 2, name: "문동주", teamId: 9, value: "185", playerId: "51344" },
    { rank: 3, name: "소형준", teamId: 5, value: "172", playerId: "50662" },
    { rank: 4, name: "이의리", teamId: 2, value: "164", playerId: "51648" },
    { rank: 5, name: "양현종", teamId: 6, value: "148", playerId: "75645" },
  ]},
  { id: "saves", label: "세이브", leaders: [
    { rank: 1, name: "정우영", teamId: 1, value: "38", playerId: "69159" },
    { rank: 2, name: "박영현", teamId: 6, value: "34", playerId: "50106" },
    { rank: 3, name: "고우석", teamId: 2, value: "31", playerId: "67119" },
    { rank: 4, name: "이승현", teamId: 8, value: "28", playerId: "51454" },
    { rank: 5, name: "조상우", teamId: 3, value: "25", playerId: "50859" },
  ]},
  { id: "holds", label: "홀드", leaders: [
    { rank: 1, name: "김진욱", teamId: 9, value: "28", playerId: "51111" },
    { rank: 2, name: "최원준", teamId: 4, value: "25", playerId: "51104" },
    { rank: 3, name: "진해수", teamId: 1, value: "22", playerId: "50030" },
    { rank: 4, name: "김재열", teamId: 5, value: "20", playerId: "67449" },
    { rank: 5, name: "임기영", teamId: 2, value: "18", playerId: "62234" },
  ]},
];

function getTeam(id: number) {
  return TEAMS.find((t) => t.id === id)!;
}

function getTeamColor(id: number) {
  return TEAMS.find((t) => t.id === id)?.colorLight ?? "#999";
}

function getStreakIcon(streak: string) {
  const num = parseInt(streak);
  if (streak.includes("연승") && num >= 3) return "🔥";
  if (streak.includes("연패") && num >= 3) return "❄️";
  return "";
}

type MainTab = "team" | "batter" | "pitcher";

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((ch) => ch + ch).join("") : c;
  return `rgba(${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)}, ${alpha})`;
}

function LeaderSection({ title, leaders, router, myTeamId, favoriteNames }: {
  title: string;
  leaders: TitleLeader[];
  router: ReturnType<typeof useRouter>;
  myTeamId: number | null;
  favoriteNames: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? leaders : leaders.slice(0, 5);

  return (
    <div className="glass-card p-4">
      <h3 className="text-base font-semibold text-text-tertiary mb-3">{title}</h3>
      <div className="space-y-3">
        {shown.map((l) => {
          const isMyTeam = myTeamId != null && l.teamId === myTeamId;
          const isFavorite = favoriteNames.has(l.name);
          const hlLevel = isFavorite ? 2 : isMyTeam ? 1 : 0;
          const teamColor = TEAMS.find((t) => t.id === l.teamId)?.colorPrimary || "#FF6B35";

          return (
          <div
            key={l.rank}
            onClick={() => l.playerId && router.push(`/community/players/${l.playerId}`)}
            className="flex items-center gap-3 cursor-pointer hover:bg-white/5 rounded-lg transition-colors py-1 px-1"
            style={hlLevel === 0 ? undefined : {
              borderLeft: `${hlLevel === 2 ? 4 : 3}px solid ${hexToRgba(teamColor, hlLevel === 2 ? 1 : 0.8)}`,
              backgroundColor: hexToRgba(teamColor, hlLevel === 2 ? 0.18 : 0.12),
              borderRadius: 8,
              paddingLeft: 8,
            }}
          >
            <span className={clsx("flex h-6 w-6 items-center justify-center rounded-full text-base font-bold",
              l.rank === 1 ? "bg-yellow-500/20 text-yellow-400" :
              l.rank === 2 ? "bg-gray-400/20 text-gray-300" :
              l.rank === 3 ? "bg-amber-700/20 text-amber-600" :
              "bg-bg-tertiary text-text-tertiary"
            )}>
              {l.rank}
            </span>
            <PlayerAvatar name={l.name} teamId={l.teamId} photoUrl={getPlayerPhotoUrl(l.name)} size={52} />
            <span className="flex-1 text-base text-text-primary">
              {l.name}
              {isFavorite && <span className="ml-1">★</span>}
            </span>
            <span className="text-base font-bold tabular-nums" style={{ color: getTeamColor(l.teamId) }}>{l.value}</span>
          </div>
          );
        })}
      </div>
      {leaders.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full mt-3 pt-2 border-t border-border text-sm text-accent font-medium"
        >
          {expanded ? "접기 ▲" : `더보기 (${leaders.length}위까지) ▼`}
        </button>
      )}
    </div>
  );
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
  const [season, setSeason] = useState<2025 | 2026>(2025);

  useEffect(() => {
    fetch("/api/standings")
      .then(r => r.json())
      .then(data => {
        if (data.standings?.length) {
          const TEAM_NAME_MAP: Record<string, number> = {
            "LG": 1, "두산": 2, "KT": 3, "SSG": 4, "NC": 5,
            "KIA": 6, "롯데": 7, "삼성": 8, "한화": 9, "키움": 10,
          };
          const mapped: TeamStanding[] = data.standings.map((s: RawStanding, i: number) => ({
            teamId: TEAM_NAME_MAP[s.teamName] ?? 0,
            season: 2025,
            rank: i + 1,
            wins: s.wins,
            losses: s.losses,
            draws: s.draws,
            pct: s.winRate,
            gb: s.gamesBehind,
            streak: "",
            last10: "",
          }));
          setRealStandings(mapped);
        }
      })
      .catch(() => {});
  }, []);

  const standings = realStandings ?? MOCK_STANDINGS;
  const [realBatters, setRealBatters] = useState<RealBatterStat[] | null>(null);
  const [realPitchers, setRealPitchers] = useState<RealPitcherStat[] | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (season !== 2025) { setRealBatters(null); setRealPitchers(null); return; }
    fetch("/api/stats?type=batter&season=2025")
      .then(r => r.json())
      .then(d => d.stats?.length && setRealBatters(d.stats))
      .catch(() => {});
    fetch("/api/stats?type=pitcher&season=2025")
      .then(r => r.json())
      .then(d => d.stats?.length && setRealPitchers(d.stats))
      .catch(() => {});
  }, [season]);
  const router = useRouter();
  const [mainTab, setMainTab] = useState<MainTab>("team");

  return (
    <div className="mx-auto max-w-lg px-5">
      <div className="border-b" style={{ borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)' }}>
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
            season === y ? "bg-accent text-white" : "bg-bg-tertiary text-text-tertiary"
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
              : "bg-bg-tertiary text-text-tertiary"
          )}
        >
          {tab.label}
        </button>
      ))}
      </div>

      {season === 2026 ? (
        <div className="py-20 text-center">
          <p className="text-4xl mb-4">⚾</p>
          <p className="text-base font-medium text-text-secondary">시즌 개막 후 확인하실 수 있습니다</p>
          <p className="text-sm text-text-tertiary mt-2">2026 정규시즌 개막: 3월 29일</p>
        </div>
      ) : (<>
      {/* Team standings */}
      {mainTab === "team" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-card overflow-hidden"
        >
          <table className="w-full text-base table-fixed">
            <colgroup>
              <col className="w-8" />
              <col />
              <col className="w-11" />
              <col className="w-11" />
              <col className="w-9" />
              <col className="w-14" />
              <col className="w-11" />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-base font-semibold text-text-tertiary">
                <th className="py-2 text-center">#</th>
                <th className="py-2 text-left pl-2">팀</th>
                <th className="py-2 text-right pr-2">승</th>
                <th className="py-2 text-right pr-2">패</th>
                <th className="py-2 text-right pr-2">무</th>
                <th className="py-2 text-right pr-2">승률</th>
                <th className="py-2 text-right pr-2">차</th>
              </tr>
            </thead>
            <tbody>
              {(season === 2025 && realStandings ? realStandings : MOCK_STANDINGS).map((standing, i) => {
                const team = getTeam(standing.teamId);
                const isMyTeam = myTeamId !== null && standing.teamId === myTeamId;
                return (
                  <motion.tr
                    key={standing.teamId}
                    onClick={() => { const t = TEAMS.find(t => t.id === standing.teamId); if (t) router.push(`/teams/${t.slug}`); }}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className={`border-b border-border/30 last:border-0 cursor-pointer hover:bg-white/5`}
                    style={isMyTeam ? {
                      backgroundColor: `${team.colorPrimary}18`,
                      borderLeft: `3px solid ${team.colorPrimary}`,
                    } : undefined}
                  >
                    <td className="py-2.5 text-center font-bold text-text-primary">{standing.rank}</td>
                    <td className="py-2.5 pl-2">
                      <div className="flex items-center gap-2">
                        <TeamLogo team={team} size={28} />
                        <span className="font-medium text-text-primary whitespace-nowrap">{team.shortName}</span>
                        {getStreakIcon(standing.streak) && <span className="text-base">{getStreakIcon(standing.streak)}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 text-right pr-2 tabular-nums text-text-primary">{standing.wins}</td>
                    <td className="py-2.5 text-right pr-2 tabular-nums text-text-primary">{standing.losses}</td>
                    <td className="py-2.5 text-right pr-2 tabular-nums text-text-secondary">{standing.draws}</td>
                    <td className="py-2.5 text-right pr-2 tabular-nums font-semibold text-text-primary">{standing.pct.toFixed(3).slice(1)}</td>
                    <td className="py-2.5 text-right pr-2 tabular-nums text-text-secondary">{standing.gb === 0 ? "-" : standing.gb}</td>
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
          className="space-y-4"
        >
          {(() => {
            const TEAM_NAME_TO_ID: Record<string, number> = { LG: 1, 두산: 2, KT: 3, SSG: 4, NC: 5, KIA: 6, 롯데: 7, 삼성: 8, 한화: 9, 키움: 10 };
            if (!realBatters) return <div className="text-center py-8 text-text-tertiary text-sm">2025 시즌 데이터 로딩 중...</div>;
            if (realBatters.length === 0) return <div className="text-center py-8 text-text-tertiary text-sm">시즌 데이터가 아직 없습니다</div>;
            // KBO 규정타석: 팀경기수(144) × 3.1 = 446타석
            const qualified = realBatters.filter((b) => Number(b.pa || 0) >= 446 || (!(b.pa) && Number(b.games || 0) >= 120));
            const toLeader = (b: RealBatterStat, valKey: string) => ({ rank: b.rank, name: b.name, teamId: TEAM_NAME_TO_ID[b.team] ?? 0, value: String(b[valKey] ?? 0), playerId: PLAYER_PHOTO_MAP[b.name] });
            const sorted = (key: string, desc = true) => [...qualified].sort((a, b) => desc ? Number(b[key] || 0) - Number(a[key] || 0) : Number(a[key] || 0) - Number(b[key] || 0)).slice(0, 20).map((b, i) => ({ ...toLeader(b, key), rank: i + 1 }));
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
            return categories.map((cat) => (
              <LeaderSection key={cat.id} router={router} title={`${cat.label} (2025)`} leaders={cat.leaders} myTeamId={myTeamId} favoriteNames={favoriteNames} />
            ));
          })()}
        </motion.div>
      )}

      {/* Pitcher titles */}
      {mainTab === "pitcher" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {(() => {
            const TEAM_NAME_TO_ID: Record<string, number> = { LG: 1, 두산: 2, KT: 3, SSG: 4, NC: 5, KIA: 6, 롯데: 7, 삼성: 8, 한화: 9, 키움: 10 };
            if (!realPitchers) return <div className="text-center py-8 text-text-tertiary text-sm">2025 시즌 데이터 로딩 중...</div>;
            if (realPitchers.length === 0) return <div className="text-center py-8 text-text-tertiary text-sm">시즌 데이터가 아직 없습니다</div>;
            // KBO 규정이닝: 팀경기수(144) × 1.0 = 144이닝
            const qualifiedP = realPitchers.filter((p) => Number(p.ip || 0) >= 144 || (!(p.ip) && Number(p.games || 0) >= 40));
            const toLeader = (p: RealPitcherStat, valKey: string) => ({ rank: p.rank, name: p.name, teamId: TEAM_NAME_TO_ID[p.team] ?? 0, value: String(p[valKey] ?? 0), playerId: PLAYER_PHOTO_MAP[p.name] });
            const sorted = (key: string, desc = true) => [...qualifiedP].sort((a, b) => desc ? Number(b[key] || 0) - Number(a[key] || 0) : Number(a[key] || 0) - Number(b[key] || 0)).slice(0, 20).map((p, i) => ({ ...toLeader(p, key), rank: i + 1 }));
            const eraTop = [...qualifiedP].sort((a, b) => Number(a.era || 99) - Number(b.era || 99)).slice(0, 20).map((p, i) => ({ ...toLeader(p, "era"), rank: i + 1 }));
            const whipTop = [...qualifiedP].filter((p) => p.whip).sort((a, b) => Number(a.whip || 99) - Number(b.whip || 99)).slice(0, 20).map((p, i) => ({ ...toLeader(p, "whip"), rank: i + 1 }));
            const categories = [
              { id: "era", label: "평균자책", leaders: eraTop },
              { id: "wins", label: "승리", leaders: sorted("wins") },
              { id: "so", label: "탈삼진", leaders: sorted("so") },
              { id: "saves", label: "세이브", leaders: sorted("saves") },
              { id: "holds", label: "홀드", leaders: sorted("holds") },
              ...(whipTop.length > 0 ? [
                { id: "whip", label: "WHIP", leaders: whipTop },
              ] : []),
            ];
            return categories.map((cat) => (
              <LeaderSection key={cat.id} router={router} title={`${cat.label} (2025)`} leaders={cat.leaders} myTeamId={myTeamId} favoriteNames={favoriteNames} />
            ));
          })()}
        </motion.div>
      )}

      </>)}
      <div className="h-4" />
    </div>
  );
}
