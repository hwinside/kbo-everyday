"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import PlayerAvatar from "@/components/ui/PlayerAvatar";
import SectionHeader from "@/components/ui/SectionHeader";
import MiniTrendSparkline from "@/components/home/MiniTrendSparkline";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getTeamById } from "@/lib/constants/teams";
import { getTeamColor } from "@/lib/utils/team";
import {
  toWeeklyTrend,
  recentAverage,
  recentEraByInnings,
  outsToInnings,
  weeklyDirection,
  type WeeklyTrendRow,
  type TrendDirection,
} from "@/lib/stats/weekly-trend";
import { getPlayerTitles } from "@/lib/stats/title-rankings";
import type { FavoritePlayer } from "@/lib/store/favorites";
import batterStats from "@/lib/constants/stats-2026-batters.json";
import pitcherStats from "@/lib/constants/stats-2026-pitchers.json";
import rosterData from "@/lib/constants/players-roster.json";

interface RosterEntry {
  name: string;
  kboId: string;
  backNo: string;
  position: string;
  teamId: number;
  team: string;
}

const rosterMap = new Map(
  (rosterData as RosterEntry[]).filter((r) => r.backNo).map((r) => [r.kboId, r])
);

interface BatterStat {
  playerId: string;
  name: string;
  team: string;
  avg: string;
  hr: number;
  rbi: number;
  ops: string;
  games: number;
}

interface PitcherStat {
  playerId: string;
  name: string;
  team: string;
  era: string;
  ip: string;
  so: number;
  whip: string;
  games: number;
  wins: number;
  losses: number;
  saves: number;
}

const batterMap = new Map(
  (batterStats as BatterStat[]).map((s) => [s.playerId, s])
);
const pitcherMap = new Map(
  (pitcherStats as PitcherStat[]).map((s) => [s.playerId, s])
);

// Fallback: 동명이인 등 playerId 불일치 시 name+team으로 재검색
function findBatter(playerId: string, name: string, teamId: number): BatterStat | undefined {
  const direct = batterMap.get(playerId);
  if (direct) return direct;
  const teamShort = getTeamById(teamId)?.shortName;
  return (batterStats as BatterStat[]).find((s) => s.name === name && s.team === teamShort);
}

function findPitcher(playerId: string, name: string, teamId: number): PitcherStat | undefined {
  const direct = pitcherMap.get(playerId);
  if (direct) return direct;
  const teamShort = getTeamById(teamId)?.shortName;
  return (pitcherStats as PitcherStat[]).find((s) => s.name === name && s.team === teamShort);
}

// 정적 스냅샷 기준 투수 분류 (라이브 fetch의 pos 결정 + 표시 블록 선택에 공통 사용).
// 기존 분류 로직 유지 — 라이브 연동은 "값"만 갱신하고 분류는 바꾸지 않음.
function classifyIsPitcher(p: FavoritePlayer): boolean {
  const batter = findBatter(p.playerId, p.name, p.teamId);
  const pitcher = findPitcher(p.playerId, p.name, p.teamId);
  return pitcher ? (!batter || p.position === "투수") : false;
}

// 라이브 소스(/api/player-stats)는 선수 상세 페이지 히어로와 동일 — 카드/페이지 숫자 일치 보장.
type StatLike = Record<string, string | number | undefined>;

// 타율을 KBO 관례(.324) 표기로.
function fmtAvg(n: number): string {
  return n.toFixed(3).replace(/^0\./, ".");
}

function TrendIcon({ dir }: { dir: TrendDirection }) {
  if (dir === "improving") return <span className="text-[#34C759] text-[11px] leading-none">▲</span>;
  if (dir === "declining") return <span className="text-[#FF453A] text-[11px] leading-none">▼</span>;
  return <span className="text-text-tertiary text-[11px] leading-none">–</span>;
}

export default function FavoritePlayersSection({ favPlayers }: { favPlayers: FavoritePlayer[] }) {
  const [liveStats, setLiveStats] = useState<Record<string, StatLike>>({});
  const [gameLogs, setGameLogs] = useState<Record<string, WeeklyTrendRow[]>>({});
  const [leagueStats, setLeagueStats] = useState<{ batter: StatLike[]; pitcher: StatLike[] }>({
    batter: [],
    pitcher: [],
  });
  const favKey = useMemo(() => favPlayers.map((p) => p.playerId).join(","), [favPlayers]);

  // 선수 상세 페이지와 동일한 라이브 소스로 갱신:
  //  - /api/player-stats     → 시즌 누적(보조 표시)
  //  - /api/player-game-logs → 출전 경기 로그(최근 3경기 평균 + 주간 추이)
  // 비-투수는 어떤 pos든 KBO 타자 상세로 크롤링되므로 상세 페이지와 정확히 같은 값.
  useEffect(() => {
    if (favPlayers.length === 0) {
      setLiveStats({});
      setGameLogs({});
      setLeagueStats({ batter: [], pitcher: [] });
      return;
    }
    let cancelled = false;
    const needBatter = favPlayers.some((p) => !classifyIsPitcher(p));
    const needPitcher = favPlayers.some((p) => classifyIsPitcher(p));
    // 부문 랭킹(타이틀 라벨)은 랭킹 페이지와 동일한 /api/stats 리그 전체에서 산출
    const fetchLeague = (type: "batter" | "pitcher") =>
      fetch(`/api/stats?type=${type}&season=2026`)
        .then((res) => (res.ok ? res.json() : { stats: [] }))
        .then((data) => (Array.isArray(data?.stats) ? (data.stats as StatLike[]) : []))
        .catch(() => [] as StatLike[]);
    (async () => {
      const [results, batterLeague, pitcherLeague] = await Promise.all([
        Promise.all(
          favPlayers.map(async (p) => {
            const pos = classifyIsPitcher(p) ? "투수" : "타자";
            const idQ = encodeURIComponent(p.playerId);
            const posQ = encodeURIComponent(pos);
            const [stats, logs] = await Promise.all([
              fetch(`/api/player-stats?id=${idQ}&pos=${posQ}`)
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => (data?.stats as StatLike | null) ?? null)
                .catch(() => null),
              fetch(`/api/player-game-logs?id=${idQ}&pos=${posQ}`)
                .then((res) => (res.ok ? res.json() : { rows: [] }))
                .then((data) => (Array.isArray(data?.rows) ? (data.rows as WeeklyTrendRow[]) : []))
                .catch(() => [] as WeeklyTrendRow[]),
            ]);
            return [p.playerId, stats, logs] as const;
          })
        ),
        needBatter ? fetchLeague("batter") : Promise.resolve([] as StatLike[]),
        needPitcher ? fetchLeague("pitcher") : Promise.resolve([] as StatLike[]),
      ]);
      if (cancelled) return;
      const sMap: Record<string, StatLike> = {};
      const gMap: Record<string, WeeklyTrendRow[]> = {};
      for (const [id, stats, logs] of results) {
        if (stats) sMap[id] = stats;
        gMap[id] = logs;
      }
      setLiveStats(sMap);
      setGameLogs(gMap);
      setLeagueStats({ batter: batterLeague, pitcher: pitcherLeague });
    })();
    return () => {
      cancelled = true;
    };
    // favKey로 최애선수 변경만 감지 (favPlayers 배열 identity 변동에 따른 재요청 방지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favKey]);

  if (favPlayers.length === 0) return null;

  return (
    <div>
      <SectionHeader title="⭐ 나의 최애 선수" />
      <div className="flex items-stretch gap-3 overflow-x-auto hide-scrollbar pb-2">
        {favPlayers.map((player) => {
          const live = liveStats[player.playerId];
          const isPitcher = classifyIsPitcher(player);
          const staticBatter = findBatter(player.playerId, player.name, player.teamId);
          const staticPitcher = findPitcher(player.playerId, player.name, player.teamId);
          const teamColor = getTeamColor(player.teamId);

          // 시즌 누적(보조): 라이브 우선, 없으면 정적 스냅샷 폴백
          let seasonAvg: number | null = null;
          let seasonEra: number | null = null;
          let seasonSub = "";
          if (isPitcher) {
            const src = (live ?? (staticPitcher as unknown as StatLike | undefined)) as StatLike | undefined;
            if (src) {
              seasonEra = Number(src.era ?? NaN);
              seasonSub = `${Number(src.wins ?? 0)}승 ${Number(src.losses ?? 0)}패 ${Number(src.saves ?? 0)}세`;
            }
          } else {
            const src = (live ?? (staticBatter as unknown as StatLike | undefined)) as StatLike | undefined;
            if (src) {
              seasonAvg = Number(src.avg ?? NaN);
              seasonSub = `${Number(src.hr ?? 0)}홈런 ${Number(src.rbi ?? 0)}타점`;
            }
          }

          // 헤드라인 지표: 타자=최근 3경기 타율 / 투수=최근 9이닝(이상) ERA(분모 안정화)
          const logs = gameLogs[player.playerId] ?? [];
          const pitcherEra = isPitcher ? recentEraByInnings(logs, 27) : null;
          const recentMetric = isPitcher ? (pitcherEra?.era ?? null) : recentAverage(logs, false, 3);
          const weekly = toWeeklyTrend(logs, isPitcher);
          const direction = weeklyDirection(weekly, isPitcher);

          // 부문 타이틀 5위 이내면 대표 1개를 하단에 라벨로 (예: "홈런 1위")
          const league = isPitcher ? leagueStats.pitcher : leagueStats.batter;
          const topTitle = getPlayerTitles(league, player.playerId, player.name, isPitcher)[0] ?? null;

          const recentLabel = isPitcher
            ? `최근 ${pitcherEra ? outsToInnings(pitcherEra.outs) : 9}이닝 ERA`
            : "최근 3경기 타율";
          const recentText =
            recentMetric != null ? (isPitcher ? recentMetric.toFixed(2) : fmtAvg(recentMetric)) : null;

          // 헤드라인: 최근 3경기 → 없으면 시즌 누적으로 graceful 폴백
          const seasonValid = isPitcher
            ? seasonEra != null && Number.isFinite(seasonEra)
            : seasonAvg != null && Number.isFinite(seasonAvg);
          const headlineText =
            recentText ??
            (seasonValid
              ? isPitcher
                ? (seasonEra as number).toFixed(2)
                : fmtAvg(seasonAvg as number)
              : null);
          const headlineLabel = recentText ? recentLabel : isPitcher ? "시즌 ERA" : "시즌 타율";

          // roster에서 실제 등번호 가져오기 (favorite 저장값이 0인 경우 대응)
          const rosterEntry = rosterMap.get(player.playerId);
          const displayNumber = (player.number && player.number !== 0)
            ? player.number
            : rosterEntry?.backNo
              ? Number(rosterEntry.backNo)
              : null;

          return (
            <Link key={player.playerId} href={`/community/players/${player.playerId}`} className="h-full">
              <div className="min-w-[168px] h-full min-h-[224px] rounded-2xl p-3 flex flex-col items-center gap-2 border border-border bg-bg-secondary">
                <PlayerAvatar
                  name={player.name}
                  teamId={player.teamId}
                  photoUrl={getPlayerPhotoUrl(player.name, player.playerId)}
                  number={displayNumber ?? player.number}
                  size={56}
                />
                <div className="text-center">
                  <p className="text-[15px] leading-[22px] font-medium text-text-primary">{player.name}</p>
                  {displayNumber ? (
                    <p className="text-xs leading-[18px] text-text-tertiary">#{displayNumber} {player.position}</p>
                  ) : (
                    <p className="text-xs leading-[18px] text-text-tertiary">{player.position}</p>
                  )}
                </div>

                {headlineText ? (
                  <div className="w-full flex flex-col items-center gap-1">
                    {/* 헤드라인: 최근 3경기 평균 + 전주 대비 추세 아이콘 */}
                    <p className="text-[11px] leading-[14px] text-text-tertiary">{headlineLabel}</p>
                    <div className="flex items-baseline justify-center gap-1">
                      <span className="text-[22px] leading-[26px] font-bold tabular-nums text-text-primary">
                        {headlineText}
                      </span>
                      {direction ? <TrendIcon dir={direction} /> : null}
                    </div>

                    {/* 주간 추이 미니 스파크라인 (2주 이상부터) */}
                    {weekly.length >= 2 ? (
                      <div className="w-full mt-0.5">
                        <MiniTrendSparkline data={weekly} teamColor={teamColor} isPitcher={isPitcher} />
                      </div>
                    ) : null}

                    {/* 시즌 누적 (보조) */}
                    {seasonValid ? (
                      <p className="text-[11px] leading-[15px] text-text-tertiary text-center">
                        시즌 {isPitcher ? (seasonEra as number).toFixed(2) : fmtAvg(seasonAvg as number)}
                        {seasonSub ? ` · ${seasonSub}` : ""}
                      </p>
                    ) : null}

                    {/* 부문 타이틀 라벨 (5위 이내) — 슬롯 높이 항상 확보해 라벨 유무로 카드 높이가 변하지 않게 */}
                    <div className="mt-1 h-[20px] flex items-center justify-center">
                      {topTitle ? (
                        <span
                          className="text-[10px] leading-[14px] font-semibold px-2 py-0.5 rounded-full"
                          style={{ color: teamColor, backgroundColor: `${teamColor}1F` }}
                        >
                          🏆 {topTitle.name} {topTitle.rank}위
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] leading-[16px] text-text-tertiary text-center">
                    2026 시즌 기록 준비 중
                  </p>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
