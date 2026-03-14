"use client";

import { useState, useMemo, useEffect } from "react";
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
  lineupConfirmed?: boolean;
}

/* ===== Scheduled: AI Preview ===== */
function ScheduledView({ awayTeamId, homeTeamId, starterNames, lineupConfirmed }: {
  awayTeamId: number;
  homeTeamId: number;
  starterNames?: { away: string; home: string };
  lineupConfirmed?: boolean;
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

      {/* AI 분석: 라인업 확정 후에만 노출 */}
      {!lineupConfirmed ? (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
          <span className="text-yellow-400 text-sm">⚠️</span>
          <span className="text-sm text-yellow-400/90">
            라인업이 확정되면 AI 경기 예측을 보실 수 있습니다.
          </span>
        </div>
      ) : (
      <>
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
      </>
      )}
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

  // LLM 요약 상태
  const [llmSummary, setLlmSummary] = useState<{
    headline: string;
    gameFlow?: { early: string; mid: string; late: string };
    turningPoint: string;
    mvpBatter: string | { name: string; stats: string; reason: string } | null;
    mvpPitcher: string | { name: string; stats: string; reason: string } | null;
    insight: string;
  } | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);

  // BoxScore가 실질적 데이터를 갖고 있는지 확인 (빈 배열이면 무의미)
  const hasRealBoxScore = boxScore &&
    (boxScore.awayBatters.length > 0 || boxScore.homeBatters.length > 0);

  // LLM 요약 fetch
  useEffect(() => {
    if (!hasRealBoxScore || llmSummary) return;

    const fetchLlmSummary = async () => {
      setLlmLoading(true);
      try {
        // 1. 캐시 확인
        const cacheRes = await fetch(`/api/game-summary?gameId=${gameId}`);
        const cacheData = await cacheRes.json();
        if (cacheData.summary) {
          setLlmSummary(cacheData.summary);
          return;
        }

        // 2. 생성 요청 — 데이터 유효성 먼저 확인
        const homeR = boxScore.homeBatters.reduce((s, b) => s + b.runs, 0);
        const awayR = boxScore.awayBatters.reduce((s, b) => s + b.runs, 0);
        const totalAB = [...boxScore.awayBatters, ...boxScore.homeBatters].reduce((s, b) => s + b.atBats, 0);
        if (totalAB === 0) {
          // BoxScore 데이터 미완성 → 생성 건너뜀 (다음 렌더에서 재시도)
          console.warn("BoxScore data incomplete (0 AB), skipping summary generation");
          return;
        }
        
        const payload = {
          gameId,
          awayTeam: awayTeam.shortName,
          homeTeam: homeTeam.shortName,
          awayScore: awayR,
          homeScore: homeR,
          awayBatters: boxScore.awayBatters.map(b => ({
            name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
            rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
          })),
          homeBatters: boxScore.homeBatters.map(b => ({
            name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
            rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
          })),
          awayPitchers: boxScore.awayPitchers.map(p => ({
            name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
            er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
            np: p.pitchCount, result: p.decision || undefined,
          })),
          homePitchers: boxScore.homePitchers.map(p => ({
            name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
            er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
            np: p.pitchCount, result: p.decision || undefined,
          })),
        };

        const genRes = await fetch("/api/game-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const genData = await genRes.json();
        if (genData.summary) {
          setLlmSummary(genData.summary);
        }
      } catch (err) {
        console.error("LLM summary fetch failed:", err);
      } finally {
        setLlmLoading(false);
      }
    };

    fetchLlmSummary();
  }, [hasRealBoxScore, boxScore, gameId, llmSummary, awayTeam, homeTeam]);

  // 기존 템플릿 기반 fallback
  const fallbackSummary = useMemo(() => {
    if (!hasRealBoxScore) return null;

    const homeR = boxScore.homeBatters.reduce((s, b) => s + b.runs, 0);
    const awayR = boxScore.awayBatters.reduce((s, b) => s + b.runs, 0);
    const isDraw = homeR === awayR;
    const homeWon = homeR > awayR;
    const winnerName = isDraw ? null : (homeWon ? homeTeam.shortName : awayTeam.shortName);
    const loserName = isDraw ? null : (homeWon ? awayTeam.shortName : homeTeam.shortName);

    // 모든 타자 통합
    const allBatters = [
      ...boxScore.homeBatters.map(b => ({ ...b, team: homeTeam.shortName, teamColor: homeTeam.colorLight })),
      ...boxScore.awayBatters.map(b => ({ ...b, team: awayTeam.shortName, teamColor: awayTeam.colorLight })),
    ];
    // 모든 투수 통합
    const allPitchers = [
      ...boxScore.homePitchers.map(p => ({ ...p, team: homeTeam.shortName })),
      ...boxScore.awayPitchers.map(p => ({ ...p, team: awayTeam.shortName })),
    ];

    // MVP: 타점 → 안타 → 홈런 순으로
    const mvpBatter = [...allBatters].sort((a, b) => (b.rbi - a.rbi) || (b.hits - a.hits) || (b.hr - a.hr))[0];
    // 최다 탈삼진 투수
    const topPitcher = [...allPitchers].sort((a, b) => b.strikeouts - a.strikeouts)[0];
    // 홈런 타자들
    const hrHitters = allBatters.filter(b => b.hr > 0);
    // 멀티히트 타자들
    const multiHitters = allBatters.filter(b => b.hits >= 2);
    // 에러
    const homeErrors = boxScore.homeBatters.reduce((s, b) => s + (("errors" in b) ? (b as { errors: number }).errors : 0), 0);
    const awayErrors = boxScore.awayBatters.reduce((s, b) => s + (("errors" in b) ? (b as { errors: number }).errors : 0), 0);

    // 가장 많은 득점이 난 이닝 찾기 (linescore 없이 boxScore만으로는 제한적 → 간접 추론)
    const totalH = boxScore.homeBatters.reduce((s, b) => s + b.hits, 0) + boxScore.awayBatters.reduce((s, b) => s + b.hits, 0);
    const totalK = allPitchers.reduce((s, p) => s + p.strikeouts, 0);

    // 헤드라인
    let headline: string;
    if (isDraw) {
      headline = `${homeTeam.shortName} vs ${awayTeam.shortName}, ${homeR}-${awayR} 무승부!`;
    } else {
      const margin = Math.abs(homeR - awayR);
      if (margin >= 5) {
        headline = `${winnerName}, ${Math.max(homeR, awayR)}-${Math.min(homeR, awayR)}로 ${loserName} 대파!`;
      } else if (margin === 1) {
        headline = `${winnerName}, ${Math.max(homeR, awayR)}-${Math.min(homeR, awayR)} 짜릿한 1점차 승리!`;
      } else {
        headline = `${winnerName}, ${Math.max(homeR, awayR)}-${Math.min(homeR, awayR)}로 ${loserName}에 승리!`;
      }
    }

    // 승부처 (리치하게)
    let turningPoint: string;
    if (isDraw) {
      turningPoint = `양 팀 모두 ${homeR}점씩 주고받은 팽팽한 접전. 시범경기 규정에 따라 무승부로 마무리되었습니다.`;
    } else {
      const winBatters = homeWon ? boxScore.homeBatters : boxScore.awayBatters;
      const winHits = winBatters.reduce((s, b) => s + b.hits, 0);
      const winRbi = winBatters.reduce((s, b) => s + b.rbi, 0);
      turningPoint = `${winnerName}이 ${winHits}안타 ${winRbi}타점으로 효과적으로 공략했습니다.`;
      if (hrHitters.length > 0) {
        turningPoint += ` ${hrHitters.map(h => `${h.team} ${h.name}`).join(", ")}의 홈런이 터졌습니다.`;
      }
    }

    // MVP 카드 (리치)
    let mvpText: string | null = null;
    if (mvpBatter && (mvpBatter.hits > 0 || mvpBatter.rbi > 0)) {
      const parts = [`${mvpBatter.hits}안타`];
      if (mvpBatter.rbi > 0) parts.push(`${mvpBatter.rbi}타점`);
      if (mvpBatter.hr > 0) parts.push(`${mvpBatter.hr}홈런`);
      if (mvpBatter.runs > 0) parts.push(`${mvpBatter.runs}득점`);
      if (mvpBatter.bb > 0) parts.push(`${mvpBatter.bb}볼넷`);
      mvpText = `${mvpBatter.team} ${mvpBatter.name} (${parts.join(" ")})`;
    }

    // 투수 하이라이트
    let pitcherHighlight: string | null = null;
    if (topPitcher && topPitcher.strikeouts >= 3) {
      pitcherHighlight = `${topPitcher.team} ${topPitcher.name} — ${topPitcher.inningsPitched}이닝 ${topPitcher.strikeouts}탈삼진`;
      if (topPitcher.earnedRuns === 0) pitcherHighlight += " 무실점";
    }

    // 종합 인사이트 (리치)
    let insight: string;
    if (isDraw) {
      insight = `총 ${totalH}안타, ${totalK}탈삼진이 오간 균형 잡힌 경기였습니다.`;
      if (multiHitters.length > 0) {
        insight += ` 멀티히트: ${multiHitters.map(h => `${h.team} ${h.name}(${h.hits}안타)`).join(", ")}.`;
      }
    } else {
      const losePitchers = homeWon ? boxScore.awayPitchers : boxScore.homePitchers;
      const loseEr = losePitchers.reduce((s, p) => s + p.earnedRuns, 0);
      insight = `${loserName} 투수진이 ${loseEr}자책점을 허용하며 흔들렸습니다.`;
      if (multiHitters.length >= 2) {
        insight += ` ${winnerName} 타선에서 ${multiHitters.filter(h => h.team === winnerName).map(h => `${h.name}(${h.hits}안타)`).join(", ")} 등이 활약했습니다.`;
      }
      if (homeErrors + awayErrors >= 2) {
        insight += ` 양 팀 합산 ${homeErrors + awayErrors}실책도 경기 흐름에 영향을 줬습니다.`;
      }
    }

    return { headline, gameFlow: undefined as { early: string; mid: string; late: string } | undefined, turningPoint, mvpText, pitcherHighlight, insight };
  }, [hasRealBoxScore, boxScore, homeTeam, awayTeam]);

  // LLM 우선, fallback 사용
  const summary = llmSummary
    ? {
        headline: llmSummary.headline,
        gameFlow: llmSummary.gameFlow,
        turningPoint: llmSummary.turningPoint,
        mvpBatterLabel: typeof llmSummary.mvpBatter === "string"
          ? llmSummary.mvpBatter
          : llmSummary.mvpBatter
            ? `${llmSummary.mvpBatter.name} (${llmSummary.mvpBatter.stats})`
            : null,
        mvpBatterReason: typeof llmSummary.mvpBatter === "object" && llmSummary.mvpBatter
          ? llmSummary.mvpBatter.reason
          : null,
        mvpText: typeof llmSummary.mvpBatter === "string"
          ? llmSummary.mvpBatter
          : llmSummary.mvpBatter
            ? `${llmSummary.mvpBatter.name} (${llmSummary.mvpBatter.stats}) — ${llmSummary.mvpBatter.reason}`
            : null,
        pitcherLabel: llmSummary.mvpPitcher == null ? null
          : typeof llmSummary.mvpPitcher === "string" ? llmSummary.mvpPitcher
          : (llmSummary.mvpPitcher.name && llmSummary.mvpPitcher.name !== "null")
            ? `${llmSummary.mvpPitcher.name} (${llmSummary.mvpPitcher.stats})`
            : null,
        pitcherReason: typeof llmSummary.mvpPitcher === "object" && llmSummary.mvpPitcher
          && llmSummary.mvpPitcher.name && llmSummary.mvpPitcher.name !== "null"
          ? llmSummary.mvpPitcher.reason
          : null,
        pitcherHighlight: llmSummary.mvpPitcher == null ? null
          : typeof llmSummary.mvpPitcher === "string" ? llmSummary.mvpPitcher
          : (llmSummary.mvpPitcher.name && llmSummary.mvpPitcher.name !== "null")
            ? `${llmSummary.mvpPitcher.name} (${llmSummary.mvpPitcher.stats}) — ${llmSummary.mvpPitcher.reason}`
            : null,
        insight: llmSummary.insight,
      }
    : fallbackSummary ? { ...fallbackSummary, mvpBatterLabel: fallbackSummary.mvpText, mvpBatterReason: null as string | null, pitcherLabel: fallbackSummary.pitcherHighlight, pitcherReason: null as string | null } : null;

  return (
    <div className="flex flex-col h-full">
      {/* AI Summary Cards */}
      <div className="px-4 py-4">
        {summary ? (
          <div className="glass-card p-5 space-y-4">
            {/* AI 라벨 */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs">🤖</span>
              <span className="text-[11px] font-semibold text-accent">
                {llmSummary ? "AI 경기 요약" : "경기 요약"}
              </span>
              {llmLoading && !summary && (
                <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
              )}
            </div>

            {/* 헤드라인 */}
            <p className="text-base font-bold text-text-primary leading-snug">{summary.headline}</p>

            {/* 경기 흐름 (LLM에서만) */}
            {summary.gameFlow && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs">⚾</span>
                  <span className="text-[11px] font-semibold text-text-tertiary">경기 흐름</span>
                </div>
                {[
                  { label: "초반 (1~3회)", text: summary.gameFlow.early },
                  { label: "중반 (4~6회)", text: summary.gameFlow.mid },
                  { label: "후반 (7~9회)", text: summary.gameFlow.late },
                ].map((phase) => (
                  <div key={phase.label}>
                    <span className="text-[10px] font-bold text-accent/70">{phase.label}</span>
                    <p className="text-sm text-text-secondary leading-relaxed mt-0.5">{phase.text}</p>
                  </div>
                ))}
              </div>
            )}

            {/* 승부처 */}
            {summary.turningPoint && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs">🔑</span>
                  <span className="text-[11px] font-semibold text-text-tertiary">승부처</span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed">{summary.turningPoint}</p>
              </div>
            )}

            {/* 오늘의 타자 */}
            {summary.mvpBatterLabel && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs">⭐</span>
                  <span className="text-[11px] font-semibold text-text-tertiary">오늘의 타자</span>
                </div>
                <p className="text-sm text-text-primary">
                  <span className="font-semibold">{summary.mvpBatterLabel}</span>
                  {summary.mvpBatterReason && (
                    <span className="font-normal text-text-secondary"> — {summary.mvpBatterReason}</span>
                  )}
                </p>
              </div>
            )}

            {/* 오늘의 투수 */}
            {summary.pitcherLabel && (
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs">🔥</span>
                  <span className="text-[11px] font-semibold text-text-tertiary">오늘의 투수</span>
                </div>
                <p className="text-sm text-text-primary">
                  <span className="font-semibold">{summary.pitcherLabel}</span>
                  {summary.pitcherReason && (
                    <span className="font-normal text-text-secondary"> — {summary.pitcherReason}</span>
                  )}
                </p>
              </div>
            )}

            {/* 경기 분석 */}
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-xs">📊</span>
                <span className="text-[11px] font-semibold text-text-tertiary">경기 분석</span>
              </div>
              <p className="text-sm text-text-secondary leading-relaxed">{summary.insight}</p>
            </div>

            <p className="text-center text-[10px] text-text-tertiary pt-1 border-t border-border/30">
              박스스코어 기반 자동 생성 · 실제와 다를 수 있습니다
            </p>
          </div>
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
  lineupConfirmed,
}: KgwanTabProps) {
  if (status === "scheduled") {
    return <ScheduledView awayTeamId={awayTeamId} homeTeamId={homeTeamId} starterNames={starterNames} lineupConfirmed={lineupConfirmed} />;
  }

  if (status === "live") {
    return <LiveView gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} gameEvents={gameEvents} />;
  }

  // final
  return <FinalView gameId={gameId} homeTeamId={homeTeamId} awayTeamId={awayTeamId} boxScore={boxScore} />;
}
