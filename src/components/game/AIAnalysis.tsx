"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Brain, TrendingUp, Swords, Zap } from "lucide-react";
import Image from "next/image";
import { getTeamById } from "@/lib/constants/teams";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { useRouter } from "next/navigation";
import playersRoster from "@/lib/constants/players-roster.json";

interface AIAnalysisProps {
  isOpen: boolean;
  onClose: () => void;
  awayTeamId: number;
  homeTeamId: number;
  gameId: string;
  awayStarter?: string;
  homeStarter?: string;
}

interface KeyPlayer {
  name: string;
  playerId: string;
  reason: string;
}

interface AnalysisData {
  away: {
    team: ReturnType<typeof getTeamById>;
    winPct: number;
    strengths: string[];
    weaknesses: string[];
  };
  home: {
    team: ReturnType<typeof getTeamById>;
    winPct: number;
    strengths: string[];
    weaknesses: string[];
  };
  keyMatchup: string;
  prediction: string;
  awayKeyPlayers: KeyPlayer[];
  homeKeyPlayers: KeyPlayer[];
  seriesContext: string | null;
  standingsImpact: string | null;
  hotPlayers: string[];
}

// Roster lookup for kboId by name+teamId
const rosterByName = new Map<string, typeof playersRoster[0]>();
for (const p of playersRoster) {
  rosterByName.set(`${p.teamId}:${p.name}`, p);
}

function getKboId(teamId: number, name: string): string {
  const player = rosterByName.get(`${teamId}:${name}`);
  return player?.kboId ?? "0";
}

export default function AIAnalysis({ isOpen, onClose, awayTeamId, homeTeamId, gameId, awayStarter, homeStarter }: AIAnalysisProps) {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const awayTeam = getTeamById(awayTeamId);
  const homeTeam = getTeamById(homeTeamId);

  useEffect(() => {
    if (!isOpen || fetchedRef.current) return;
    fetchedRef.current = true;

    async function fetchAnalysis() {
      try {
        // 1) 캐시 확인
        const cacheRes = await fetch(`/api/game-preview?gameId=${gameId}`);
        const cacheData = await cacheRes.json();
        if (cacheData.source === "too_early") {
          setNotice(cacheData.message || "경기 12시간 전부터 AI 경기 예측 조회가 가능합니다.");
          return;
        }

        let preview = cacheData.preview;

        if (!preview) {
          // 2) 생성 요청
          const genRes = await fetch("/api/game-preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              gameId,
              awayTeamId,
              homeTeamId,
              awayStarter,
              homeStarter,
            }),
          });
          const genData = await genRes.json();
          if (genData.source === "too_early") {
            setNotice(genData.message || "경기 12시간 전부터 AI 경기 예측 조회가 가능합니다.");
            return;
          }
          preview = genData.preview;
        }

        if (!preview) {
          setError(true);
          return;
        }

        // API 응답을 UI 데이터로 변환
        const awayKeyPlayers: KeyPlayer[] = (preview.awayKeyPlayers || []).map(
          (p: { name: string; reason: string }) => ({
            name: p.name,
            playerId: getKboId(awayTeamId, p.name),
            reason: p.reason,
          })
        );
        const homeKeyPlayers: KeyPlayer[] = (preview.homeKeyPlayers || []).map(
          (p: { name: string; reason: string }) => ({
            name: p.name,
            playerId: getKboId(homeTeamId, p.name),
            reason: p.reason,
          })
        );

        setAnalysis({
          away: {
            team: awayTeam,
            winPct: preview.awayWinPct,
            strengths: preview.awayStrengths || [],
            weaknesses: preview.awayWeaknesses || [],
          },
          home: {
            team: homeTeam,
            winPct: preview.homeWinPct,
            strengths: preview.homeStrengths || [],
            weaknesses: preview.homeWeaknesses || [],
          },
          keyMatchup: preview.keyMatchup,
          prediction: preview.prediction,
          awayKeyPlayers,
          homeKeyPlayers,
          seriesContext: preview.seriesContext || null,
          standingsImpact: preview.standingsImpact || null,
          hotPlayers: preview.hotPlayers || [],
        });
      } catch (err) {
        console.error("AI Analysis fetch error:", err);
        setError(true);
      } finally {
        setLoading(false);
      }
    }

    fetchAnalysis();
  }, [isOpen, gameId, awayTeamId, homeTeamId, awayTeam, homeTeam, awayStarter, homeStarter]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-0 z-50 bg-bg-secondary overflow-y-auto overscroll-contain"
            style={{ maxHeight: "85vh" }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-2">
              <div className="h-1 w-10 rounded-full bg-text-tertiary" />
            </div>

            {/* Header */}
            <div className="sticky top-0 z-10 bg-bg-secondary flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Brain size={20} className="text-accent" />
                <h2 className="text-lg font-bold text-text-primary">AI 분석</h2>
              </div>
              <button onClick={onClose} className="text-text-secondary p-1">
                <X size={22} />
              </button>
            </div>

            <div className="px-5 pb-8 space-y-5">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <div className="w-6 h-6 border-2 border-text-tertiary border-t-accent rounded-full animate-spin" />
                  <span className="text-sm text-text-tertiary">AI가 분석 중...</span>
                </div>
              ) : notice ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 px-6 text-center">
                  <span className="text-sm text-text-secondary">{notice}</span>
                </div>
              ) : error || !analysis ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <span className="text-sm text-text-tertiary">AI 예측을 준비 중입니다</span>
                  <span className="text-xs text-text-tertiary">잠시 후 다시 시도해 주세요</span>
                </div>
              ) : (
                <>
                  {/* Win probability bar */}
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-white p-1 flex items-center justify-center">
                          <Image src={analysis.away.team!.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
                        </div>
                        <span className="text-base font-bold" style={{ color: analysis.away.team!.colorLight }}>
                          {analysis.away.team!.shortName}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-base font-bold" style={{ color: analysis.home.team!.colorLight }}>
                          {analysis.home.team!.shortName}
                        </span>
                        <div className="w-8 h-8 rounded-full bg-white p-1 flex items-center justify-center">
                          <Image src={analysis.home.team!.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
                        </div>
                      </div>
                    </div>

                    {/* Probability bar */}
                    <div className="flex h-10 rounded-xl overflow-hidden">
                      <motion.div
                        initial={{ width: "50%" }}
                        animate={{ width: `${analysis.away.winPct}%` }}
                        transition={{ duration: 1, ease: "easeOut" }}
                        className="flex items-center justify-center text-white text-sm font-bold"
                        style={{ backgroundColor: analysis.away.team!.colorPrimary }}
                      >
                        {analysis.away.winPct}%
                      </motion.div>
                      <motion.div
                        initial={{ width: "50%" }}
                        animate={{ width: `${analysis.home.winPct}%` }}
                        transition={{ duration: 1, ease: "easeOut" }}
                        className="flex items-center justify-center text-white text-sm font-bold"
                        style={{ backgroundColor: analysis.home.team!.colorPrimary }}
                      >
                        {analysis.home.winPct}%
                      </motion.div>
                    </div>
                  </div>

                  {/* Team analysis cards */}
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { side: analysis.away, keyPlayers: analysis.awayKeyPlayers },
                      { side: analysis.home, keyPlayers: analysis.homeKeyPlayers },
                    ].map(({ side }) => (
                      <div key={side.team!.id} className="glass-card p-3 space-y-2">
                        <div className="flex items-center gap-1.5 mb-2">
                          <div className="w-5 h-5 rounded-full bg-white p-0.5 flex items-center justify-center">
                            <Image src={side.team!.logoPath} alt="" width={14} height={14} unoptimized className="object-contain" />
                          </div>
                          <span className="text-sm font-bold" style={{ color: side.team!.colorLight }}>{side.team!.shortName}</span>
                        </div>
                        <div>
                          <div className="flex items-center gap-1 mb-1">
                            <TrendingUp size={12} className="text-green-400" />
                            <span className="text-xs font-semibold text-green-400">강점</span>
                          </div>
                          {side.strengths.map((s, i) => (
                            <p key={i} className="readable-body ml-4">• {s}</p>
                          ))}
                        </div>
                        <div>
                          <div className="flex items-center gap-1 mb-1">
                            <Zap size={12} className="text-red-400" />
                            <span className="text-xs font-semibold text-red-400">약점</span>
                          </div>
                          {side.weaknesses.map((w, i) => (
                            <p key={i} className="readable-body ml-4">• {w}</p>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Key matchup */}
                  <div className="glass-card p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Swords size={16} className="text-accent" />
                      <span className="text-sm font-bold text-text-primary">핵심 포인트</span>
                    </div>
                    <p className="readable-body whitespace-pre-line">{analysis.keyMatchup}</p>
                  </div>

                  {/* Series & Standings context */}
                  {(analysis.seriesContext || analysis.standingsImpact) && (
                    <div className="glass-card p-4 space-y-2">
                      {analysis.seriesContext && (
                        <div>
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-xs">📊</span>
                            <span className="text-xs font-semibold text-text-secondary">시리즈 맥락</span>
                          </div>
                          <p className="readable-body">{analysis.seriesContext}</p>
                        </div>
                      )}
                      {analysis.standingsImpact && (
                        <div>
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-xs">🏆</span>
                            <span className="text-xs font-semibold text-text-secondary">순위 영향</span>
                          </div>
                          <p className="readable-body">{analysis.standingsImpact}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Hot Players */}
                  {analysis.hotPlayers.length > 0 && (
                    <div className="glass-card p-4">
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className="text-xs">🔥</span>
                        <span className="text-xs font-semibold text-text-secondary">최근 핫 플레이어</span>
                      </div>
                      <div className="space-y-1">
                        {analysis.hotPlayers.map((hp, i) => (
                          <p key={i} className="readable-body">• {hp}</p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Prediction */}
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.5 }}
                    className="text-center py-3 rounded-xl"
                    style={{
                      background: `linear-gradient(135deg, ${analysis.away.team!.colorPrimary}20, ${analysis.home.team!.colorPrimary}20)`,
                    }}
                  >
                    <p className="text-xs text-text-tertiary mb-1">🤖 AI 예측</p>
                    <p className="text-base font-bold text-text-primary">{analysis.prediction}</p>
                  </motion.div>

                  {/* Key Players */}
                  <div className="glass-card p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-base">⭐</span>
                      <span className="text-sm font-bold text-text-primary">승부의 키플레이어</span>
                    </div>

                    {[
                      { label: analysis.away.team!.shortName, color: analysis.away.team!.colorLight, players: analysis.awayKeyPlayers, teamId: awayTeamId },
                      { label: analysis.home.team!.shortName, color: analysis.home.team!.colorLight, players: analysis.homeKeyPlayers, teamId: homeTeamId },
                    ].map((side) => (
                      <div key={side.label} className="mb-4 last:mb-0">
                        <span className="text-xs font-bold mb-2 block" style={{ color: side.color }}>{side.label}</span>
                        <div className="space-y-2.5">
                          {side.players.map((p) => (
                            <div
                              key={p.playerId}
                              onClick={() => { onClose(); router.push(`/community/players/${p.playerId}`); }}
                              className="flex items-start gap-3 p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors"
                            >
                              <PlayerAvatar name={p.name} teamId={side.teamId} photoUrl={getPlayerPhotoUrl(p.name, (playersRoster as { name: string; kboId: string }[]).find(r => r.name === p.name)?.kboId)} size={48} />
                              <div className="flex-1 min-w-0">
                                <span className="text-sm font-bold text-text-primary">{p.name}</span>
                                <p className="readable-body mt-0.5">{p.reason}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="text-center text-xs text-text-tertiary">
                    ※ AI 분석은 참고용이며 실제 경기 결과와 다를 수 있습니다
                  </p>
                </>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
