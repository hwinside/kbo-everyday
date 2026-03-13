"use client";

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronUp } from "lucide-react";
import { clsx } from "clsx";
import Image from "next/image";
import { TrendingUp, Zap, Swords } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";
import { generateAnalysis } from "@/components/game/AIAnalysis";
import GameChat from "@/components/game/GameChat";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { useRouter } from "next/navigation";
import type { GameEvent } from "@/types/game-events";
import type { GamePlay } from "@/lib/types";
import type { GameDetailResponse } from "@/app/api/game-detail/route";

interface KgwanTabProps {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  status: "scheduled" | "live" | "final";
  gameEvents: GameEvent[];
  plays: GamePlay[];
  teamColor: string;
  boxScore: GameDetailResponse["boxScore"] | null;
  starterNames?: { away: string; home: string };
}

/* ===== Scheduled: AI Preview ===== */
function ScheduledView({ awayTeamId, homeTeamId, starterNames }: {
  awayTeamId: number;
  homeTeamId: number;
  starterNames?: { away: string; home: string };
}) {
  const router = useRouter();
  const analysis = useMemo(() => generateAnalysis(awayTeamId, homeTeamId), [awayTeamId, homeTeamId]);
  const awayTeam = getTeamById(awayTeamId)!;
  const homeTeam = getTeamById(homeTeamId)!;

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Starter matchup card */}
      <div className="glass-card p-4">
        <div className="text-xs text-text-tertiary text-center mb-3">선발 투수 매치업</div>
        <div className="flex items-center justify-between">
          <div className="flex flex-col items-center gap-2 flex-1">
            <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center">
              <Image src={awayTeam.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
            </div>
            <span className="text-sm font-bold" style={{ color: awayTeam.colorLight }}>{awayTeam.shortName}</span>
            <span className="text-base font-semibold text-text-primary">{starterNames?.away || "미정"}</span>
          </div>
          <span className="text-text-tertiary text-lg font-bold">VS</span>
          <div className="flex flex-col items-center gap-2 flex-1">
            <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center">
              <Image src={homeTeam.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
            </div>
            <span className="text-sm font-bold" style={{ color: homeTeam.colorLight }}>{homeTeam.shortName}</span>
            <span className="text-base font-semibold text-text-primary">{starterNames?.home || "미정"}</span>
          </div>
        </div>
      </div>

      {/* Win probability bar */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-white p-0.5 flex items-center justify-center">
              <Image src={analysis.away.team.logoPath} alt="" width={18} height={18} unoptimized className="object-contain" />
            </div>
            <span className="text-sm font-bold" style={{ color: analysis.away.team.colorLight }}>{analysis.away.team.shortName}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold" style={{ color: analysis.home.team.colorLight }}>{analysis.home.team.shortName}</span>
            <div className="w-6 h-6 rounded-full bg-white p-0.5 flex items-center justify-center">
              <Image src={analysis.home.team.logoPath} alt="" width={18} height={18} unoptimized className="object-contain" />
            </div>
          </div>
        </div>
        <div className="flex h-8 rounded-xl overflow-hidden">
          <motion.div
            initial={{ width: "50%" }}
            animate={{ width: `${analysis.away.winPct}%` }}
            transition={{ duration: 1, ease: "easeOut" }}
            className="flex items-center justify-center text-white text-xs font-bold"
            style={{ backgroundColor: analysis.away.team.colorPrimary }}
          >
            {analysis.away.winPct}%
          </motion.div>
          <motion.div
            initial={{ width: "50%" }}
            animate={{ width: `${analysis.home.winPct}%` }}
            transition={{ duration: 1, ease: "easeOut" }}
            className="flex items-center justify-center text-white text-xs font-bold"
            style={{ backgroundColor: analysis.home.team.colorPrimary }}
          >
            {analysis.home.winPct}%
          </motion.div>
        </div>
        <div className="mt-1.5 text-center">
          <span className="text-[10px] text-text-tertiary">AI 신뢰도 {analysis.confidence}%</span>
        </div>
      </div>

      {/* Strengths / Weaknesses */}
      <div className="grid grid-cols-2 gap-3">
        {[analysis.away, analysis.home].map((side) => (
          <div key={side.team.id} className="glass-card p-3 space-y-2">
            <div className="flex items-center gap-1.5 mb-1">
              <div className="w-5 h-5 rounded-full bg-white p-0.5 flex items-center justify-center">
                <Image src={side.team.logoPath} alt="" width={14} height={14} unoptimized className="object-contain" />
              </div>
              <span className="text-xs font-bold" style={{ color: side.team.colorLight }}>{side.team.shortName}</span>
            </div>
            <div>
              <div className="flex items-center gap-1 mb-1">
                <TrendingUp size={10} className="text-green-400" />
                <span className="text-[10px] font-semibold text-green-400">강점</span>
              </div>
              {side.strengths.map((s, i) => (
                <p key={i} className="text-[11px] text-text-secondary ml-3">• {s}</p>
              ))}
            </div>
            <div>
              <div className="flex items-center gap-1 mb-1">
                <Zap size={10} className="text-red-400" />
                <span className="text-[10px] font-semibold text-red-400">약점</span>
              </div>
              {side.weaknesses.map((w, i) => (
                <p key={i} className="text-[11px] text-text-secondary ml-3">• {w}</p>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Key matchup */}
      <div className="glass-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <Swords size={14} className="text-accent" />
          <span className="text-sm font-bold text-text-primary">핵심 포인트</span>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-line">{analysis.keyMatchup}</p>
      </div>

      {/* Key Players */}
      <div className="glass-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm">⭐</span>
          <span className="text-sm font-bold text-text-primary">키플레이어</span>
        </div>
        {[
          { label: analysis.away.team.shortName, color: analysis.away.team.colorLight, players: analysis.awayKeyPlayers, teamId: awayTeamId },
          { label: analysis.home.team.shortName, color: analysis.home.team.colorLight, players: analysis.homeKeyPlayers, teamId: homeTeamId },
        ].map((side) => (
          <div key={side.label} className="mb-3 last:mb-0">
            <span className="text-[10px] font-bold mb-1.5 block" style={{ color: side.color }}>{side.label}</span>
            <div className="space-y-2">
              {side.players.map((p) => (
                <div
                  key={p.playerId}
                  onClick={() => router.push(`/community/players/${p.playerId}`)}
                  className="flex items-start gap-2.5 p-1.5 rounded-xl hover:bg-white/5 cursor-pointer transition-colors"
                >
                  <PlayerAvatar name={p.name} teamId={side.teamId} photoUrl={getPlayerPhotoUrl(p.name)} size={40} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-bold text-text-primary">{p.name}</span>
                    <p className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">{p.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="text-center text-[10px] text-text-tertiary pb-2">
        ※ AI 분석은 참고용이며 실제 경기 결과와 다를 수 있습니다
      </p>
    </div>
  );
}

/* ===== Live: Relay + Chat ===== */
function LiveView({ gameId, homeTeamId, awayTeamId, gameEvents }: {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  gameEvents: GameEvent[];
}) {
  const [expanded, setExpanded] = useState(false);

  const recentEvents = gameEvents.slice(0, expanded ? gameEvents.length : 3);

  return (
    <div className="flex flex-col h-full">
      {/* Live relay strip */}
      {gameEvents.length > 0 && (
        <div className="bg-bg-tertiary border-b border-border">
          <div className="flex items-stretch">
            <div className="w-1 bg-red-500 shrink-0 rounded-r" />
            <div className="flex-1 px-3 py-2 space-y-1">
              {recentEvents.map((ev) => (
                <p key={ev.id} className="text-xs text-text-secondary leading-relaxed">
                  <span className="text-text-tertiary mr-1.5">{ev.inning}회{ev.isTop ? "초" : "말"}</span>
                  {ev.text}
                </p>
              ))}
            </div>
          </div>
          {gameEvents.length > 3 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="w-full flex items-center justify-center gap-1 py-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors border-t border-border/50"
            >
              {expanded ? (
                <>접기 <ChevronUp size={12} /></>
              ) : (
                <>전체 중계 보기 ({gameEvents.length}개) <ChevronDown size={12} /></>
              )}
            </button>
          )}
        </div>
      )}

      {/* Chat */}
      <GameChat gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} />
    </div>
  );
}

/* ===== Final: AI Summary + Chat ===== */
function FinalView({ gameId, homeTeamId, awayTeamId, boxScore }: {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  boxScore: GameDetailResponse["boxScore"] | null;
}) {
  const homeTeam = getTeamById(homeTeamId)!;
  const awayTeam = getTeamById(awayTeamId)!;

  // Mock AI summary — v1 uses boxScore-based simple heuristics
  const summary = useMemo(() => {
    if (!boxScore) return null;

    const homeR = boxScore.homeBatters.reduce((s, b) => s + b.runs, 0);
    const awayR = boxScore.awayBatters.reduce((s, b) => s + b.runs, 0);
    const winnerName = homeR >= awayR ? homeTeam.shortName : awayTeam.shortName;
    const loserName = homeR >= awayR ? awayTeam.shortName : homeTeam.shortName;

    // MVP: most RBI
    const allBatters = [
      ...boxScore.homeBatters.map(b => ({ ...b, team: homeTeam.shortName })),
      ...boxScore.awayBatters.map(b => ({ ...b, team: awayTeam.shortName })),
    ];
    const mvp = allBatters.sort((a, b) => b.rbi - a.rbi)[0];

    return {
      headline: `${winnerName}, ${homeR >= awayR ? homeR : awayR}-${homeR >= awayR ? awayR : homeR}로 ${loserName}에 승리!`,
      turningPoint: `${winnerName}의 집중 타선이 경기를 결정지었습니다`,
      mvp: mvp ? `${mvp.team} ${mvp.name} (${mvp.hits}안타 ${mvp.rbi}타점)` : null,
      insight: `${winnerName}이 효율적인 타격으로 ${loserName} 투수진을 공략했습니다`,
    };
  }, [boxScore, homeTeam, awayTeam]);

  return (
    <div className="flex flex-col h-full">
      {/* AI Summary Cards */}
      <div className="px-4 py-4 space-y-2.5">
        {summary ? (
          <>
            <div className="glass-card p-3 flex items-start gap-2.5">
              <span className="text-base shrink-0">📰</span>
              <div>
                <span className="text-[10px] text-text-tertiary block mb-0.5">한 줄 헤드라인</span>
                <p className="text-sm font-bold text-text-primary">{summary.headline}</p>
              </div>
            </div>
            <div className="glass-card p-3 flex items-start gap-2.5">
              <span className="text-base shrink-0">🔑</span>
              <div>
                <span className="text-[10px] text-text-tertiary block mb-0.5">승부처</span>
                <p className="text-sm text-text-secondary">{summary.turningPoint}</p>
              </div>
            </div>
            {summary.mvp && (
              <div className="glass-card p-3 flex items-start gap-2.5">
                <span className="text-base shrink-0">⭐</span>
                <div>
                  <span className="text-[10px] text-text-tertiary block mb-0.5">오늘의 선수</span>
                  <p className="text-sm font-semibold text-text-primary">{summary.mvp}</p>
                </div>
              </div>
            )}
            <div className="glass-card p-3 flex items-start gap-2.5">
              <span className="text-base shrink-0">📊</span>
              <div>
                <span className="text-[10px] text-text-tertiary block mb-0.5">왜 이런 결과가?</span>
                <p className="text-sm text-text-secondary">{summary.insight}</p>
              </div>
            </div>
          </>
        ) : (
          <div className="glass-card p-4 text-center text-text-tertiary text-sm">
            경기 데이터 집계 중...
          </div>
        )}
      </div>

      {/* Post-game chat */}
      <GameChat gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} />
    </div>
  );
}

/* ===== Main KgwanTab ===== */
export default function KgwanTab({
  gameId,
  homeTeamId,
  awayTeamId,
  status,
  gameEvents,
  teamColor: _teamColor,
  plays: _plays,
  boxScore,
  starterNames,
}: KgwanTabProps) {
  if (status === "scheduled") {
    return <ScheduledView awayTeamId={awayTeamId} homeTeamId={homeTeamId} starterNames={starterNames} />;
  }

  if (status === "live") {
    return <LiveView gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} gameEvents={gameEvents} />;
  }

  // final
  return <FinalView gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} boxScore={boxScore} />;
}
