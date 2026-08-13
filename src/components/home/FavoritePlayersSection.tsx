"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";

import PlayerAvatar from "@/components/ui/PlayerAvatar";
import SectionHeader from "@/components/ui/SectionHeader";
import MiniTrendSparkline from "@/components/home/MiniTrendSparkline";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getTeamById } from "@/lib/constants/teams";
import { getTeamColor } from "@/lib/utils/team";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
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

// 히어로 컷아웃(배경 제거)은 검수 통과 선수만 — 없으면 헤드샷 아바타 폴백
const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);
const heroCutoutUrl = (kboId: string): string | null =>
  HERO_APPROVED.has(kboId) ? `/players-hero/${kboId}.webp` : null;

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
// 단, 정적 스냅샷에 둘 다 없는 신규 선수(시즌 중 합류 외국인 등, 예: 리오스 FP022)는
// roster/favorite position으로 폴백 — 안 그러면 투수가 타자로 오분류돼 "시즌 기록 준비 중"으로 빈다.
function classifyIsPitcher(p: FavoritePlayer): boolean {
  const batter = findBatter(p.playerId, p.name, p.teamId);
  const pitcher = findPitcher(p.playerId, p.name, p.teamId);
  if (pitcher) return !batter || p.position === "투수";
  if (batter) return false;
  return (rosterMap.get(p.playerId)?.position ?? p.position) === "투수";
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

type TodayGame = {
  show: boolean;
  isLive: boolean;
  opponentName: string | null;
  type: "batter" | "pitcher";
  batter?: { ab: number; h: number; hr: number; rbi: number; runs: number; bb: number; sb: number; onBase: number };
  pitcher?: { ip: string; pitches: number; k: number; bb: number; hits: number; runs: number; er: number; decision: string };
};

// 타자 강조칩 (값>0만, 최대 4개): 홈런·타점·출루·도루·득점 우선순위
function batterTodayChips(b: NonNullable<TodayGame["batter"]>): string[] {
  const out: string[] = [];
  if (b.hr > 0) out.push(`${b.hr}홈런`);
  if (b.rbi > 0) out.push(`${b.rbi}타점`);
  if (b.onBase > 0) out.push(`${b.onBase}출루`);
  if (b.sb > 0) out.push(`${b.sb}도루`);
  if (b.runs > 0) out.push(`${b.runs}득점`);
  return out.slice(0, 4);
}
// 투수 강조칩: 탈삼진·볼넷·피안타·실점
function pitcherTodayChips(p: NonNullable<TodayGame["pitcher"]>): string[] {
  return [`${p.k}K`, `${p.bb}볼넷`, `${p.hits}피안타`, `${p.runs}실점`];
}

export default function FavoritePlayersSection({ favPlayers, refreshNonce = 0 }: { favPlayers: FavoritePlayer[]; refreshNonce?: number }) {
  const [liveStats, setLiveStats] = useState<Record<string, StatLike>>({});
  const [gameLogs, setGameLogs] = useState<Record<string, WeeklyTrendRow[]>>({});
  const [leagueStats, setLeagueStats] = useState<{ batter: StatLike[]; pitcher: StatLike[] }>({
    batter: [],
    pitcher: [],
  });
  const [todayGames, setTodayGames] = useState<Record<string, TodayGame>>({});
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
  }, [favKey, refreshNonce]);

  // 오늘 경기 활약 — 팀의 당일 경기 박스스코어 라인. 라이브 갱신 위해 45초 폴링.
  useEffect(() => {
    if (favPlayers.length === 0) { setTodayGames({}); return; }
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(
        favPlayers.map(async (p) => {
          const pos = classifyIsPitcher(p) ? "투수" : "타자";
          const r: TodayGame | null = await fetch(
            `/api/player-today-game?team=${p.teamId}&name=${encodeURIComponent(p.name)}&pos=${encodeURIComponent(pos)}`,
          )
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null);
          return [p.playerId, r] as const;
        }),
      );
      if (cancelled) return;
      const m: Record<string, TodayGame> = {};
      for (const [id, r] of entries) if (r && r.show) m[id] = r;
      setTodayGames(m);
    };
    load();
    const iv = setInterval(load, 45000);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favKey, refreshNonce]);

  if (favPlayers.length === 0) return null;

  return (
    <div>
      <SectionHeader title="⭐ 나의 최애 선수" />
      <div className="flex flex-col gap-2.5">
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

          const today = todayGames[player.playerId];

          // 헤드라인 지표: 타자=최근 3경기 타율 / 투수=최근 9이닝(이상) ERA(분모 안정화)
          const logs = gameLogs[player.playerId] ?? [];
          const pitcherEra = isPitcher ? recentEraByInnings(logs, 27) : null;
          const recentMetric = isPitcher ? (pitcherEra?.era ?? null) : recentAverage(logs, false, 3);
          const weekly = toWeeklyTrend(logs, isPitcher);
          const direction = weeklyDirection(weekly, isPitcher);

          // 부문 타이틀 5위 이내면 전부 라벨로 (순위순). 타이틀 하나하나가 영광 — 약어/생략 없이 그대로
          const league = isPitcher ? leagueStats.pitcher : leagueStats.batter;
          const titles = getPlayerTitles(league, player.playerId, player.name, isPitcher);

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

          const heroUrl = heroCutoutUrl(player.playerId);

          return (
            <Link key={player.playerId} href={`/community/players/${player.playerId}`} prefetch={false}>
              <div className="rounded-2xl overflow-hidden border border-border bg-bg-secondary">
                {/* 상단: 히어로샷 + 기본정보 — 히어로 사진이 잘리지 않을 높이 확보, 하단 정렬 */}
                <div className="flex gap-2.5 pr-3.5 min-h-[120px]">
                  {/* 히어로 컷아웃 — 정보 영역 높이에 맞춰 채움(고정 높이로 행을 키우지 않음) */}
                  <div
                    className="relative w-[108px] flex-shrink-0 self-stretch overflow-hidden"
                    style={{ background: `linear-gradient(160deg, ${teamColor}1F, transparent 72%)` }}
                  >
                    {heroUrl ? (
                      // portrait hero source를 cover로 채우면 머리/목이 잘린다(삼순 NO-GO).
                      // 상단 16px 헤드룸 밴드에 object-contain object-bottom — 모자·얼굴·목 전체
                      // 노출, crop 0. 삼순 390px Chrome 렌더 검증값.
                      <div className="absolute inset-x-0 bottom-0 top-[16px]">
                        <Image
                          src={heroUrl}
                          alt={player.name}
                          fill
                          unoptimized
                          sizes="108px"
                          className="object-contain object-bottom"
                        />
                      </div>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <PlayerAvatar
                          name={player.name}
                          teamId={player.teamId}
                          photoUrl={getPlayerPhotoUrl(player.name, player.playerId)}
                          number={displayNumber ?? player.number}
                          size={72}
                        />
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 py-2.5">
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="text-[16px] leading-[22px] font-semibold text-text-primary truncate">{player.name}</p>
                        <p className="text-xs leading-[18px] text-text-tertiary">
                          {displayNumber ? `#${displayNumber} ${player.position}` : player.position}
                        </p>
                      </div>
                      {headlineText ? (
                        <div className="text-right flex-shrink-0">
                          <p className="text-[11px] leading-[14px] text-text-tertiary">{headlineLabel}</p>
                          <div className="flex items-baseline justify-end gap-1">
                            <span className="text-[22px] leading-[26px] font-bold tabular-nums text-text-primary">
                              {headlineText}
                            </span>
                            {direction ? <TrendIcon dir={direction} /> : null}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {headlineText ? (
                      <>
                        {weekly.length >= 2 ? (
                          <div className="w-full mt-0.5">
                            <p className="text-[10px] leading-[13px] text-text-tertiary mb-0">
                              시즌 주간 페이스 · {isPitcher ? "ERA" : "타율"}
                            </p>
                            <MiniTrendSparkline data={weekly} teamColor={teamColor} isPitcher={isPitcher} />
                          </div>
                        ) : null}
                        {seasonValid ? (
                          <p className="text-[10px] leading-[14px] text-text-tertiary mt-0.5">
                            시즌 {isPitcher ? (seasonEra as number).toFixed(2) : fmtAvg(seasonAvg as number)}
                            {seasonSub ? ` · ${seasonSub}` : ""}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-[12px] leading-[16px] text-text-tertiary mt-2">
                        2026 시즌 기록 준비 중
                      </p>
                    )}
                  </div>
                </div>

                {/* 오늘 경기 활약 — 라이브~당일 24:00. 기본 정보와 타이틀 사이 */}
                {today?.show ? (
                  <div className="border-t border-border px-3.5 py-2.5">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <span className="text-[10px] font-bold tracking-wide text-text-tertiary">오늘 경기</span>
                      {today.isLive ? (
                        <span className="rounded-full bg-red-500/20 px-1.5 py-[1px] text-[9px] font-extrabold tracking-wide text-red-400 animate-pulse">LIVE</span>
                      ) : null}
                      {today.opponentName ? (
                        <span className="text-[10px] text-text-tertiary">vs {today.opponentName}</span>
                      ) : null}
                    </div>
                    {today.type === "batter" && today.batter ? (
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-[15px] font-bold leading-[18px] text-text-primary">{today.batter.ab}타수 {today.batter.h}안타</span>
                        <span className="flex flex-wrap gap-1.5">
                          {batterTodayChips(today.batter).map((c, i) => (
                            <span key={i} className="rounded-full px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap" style={{ color: teamColor, backgroundColor: `${teamColor}1F` }}>{c}</span>
                          ))}
                        </span>
                      </div>
                    ) : today.type === "pitcher" && today.pitcher ? (
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-[15px] font-bold leading-[18px] text-text-primary">{today.pitcher.ip}이닝{today.pitcher.pitches > 0 ? ` · ${today.pitcher.pitches}구` : ""}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {today.pitcher.decision ? (
                            <span className="rounded-full px-1.5 py-0.5 text-[11px] font-bold whitespace-nowrap" style={{ color: "#fff", backgroundColor: teamColor }}>{today.pitcher.decision}</span>
                          ) : null}
                          {pitcherTodayChips(today.pitcher).map((c, i) => (
                            <span key={i} className="rounded-full px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap" style={{ color: teamColor, backgroundColor: `${teamColor}1F` }}>{c}</span>
                          ))}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* 하단: 부문 타이틀 — 카드 전체 폭, 5위 이내 전부 (폰트=시즌 라인 크기로 축소해 한 줄에 최대한) */}
                {titles.length > 0 ? (
                  <div className="border-t border-border px-3.5 py-2.5 flex flex-wrap gap-1.5">
                    {titles.map((t, i) => (
                      <span
                        key={t.statKey}
                        className="text-[10px] leading-[14px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap"
                        style={{ color: teamColor, backgroundColor: `${teamColor}1F` }}
                      >
                        {i === 0 ? "🏆 " : ""}{t.name} {t.rank}위
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
