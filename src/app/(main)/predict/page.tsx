"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, Star, Zap, TrendingUp, ChevronRight, Lock, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS } from "@/lib/constants/teams";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import LoginSheet from "@/components/auth/LoginSheet";
import { usePredictions } from "@/lib/supabase/usePredictions";

interface PlayerStat {
  name: string;
  avg?: string;
  hr?: string;
  rbi?: string;
  wins?: string;
  era?: string;
  [key: string]: string | number | undefined;
}

interface PredictionCategory {
  id: string;
  title: string;
  icon: React.ReactNode;
  description: string;
  type: "team" | "player";
  statFilter?: "batter" | "pitcher";
}

const CATEGORIES: PredictionCategory[] = [
  { id: "champion", title: "우승팀", icon: <Trophy size={20} />, description: "2026 한국시리즈 우승은?", type: "team" },
  { id: "mvp", title: "정규시즌 MVP", icon: <Star size={20} />, description: "올해의 가장 빛나는 선수는?", type: "player", statFilter: "batter" as const },
  { id: "rookie", title: "신인왕", icon: <Zap size={20} />, description: "최고의 루키는 누구? (2025 신인 포함 전체)", type: "player" },
  { id: "batting", title: "타격왕", icon: <TrendingUp size={20} />, description: "최고 타율의 주인공은?", type: "player", statFilter: "batter" },
  { id: "homerun", title: "홈런왕", icon: <Trophy size={20} />, description: "가장 많은 홈런을 칠 선수는?", type: "player", statFilter: "batter" },
  { id: "wins", title: "다승왕", icon: <Star size={20} />, description: "가장 많이 이길 투수는?", type: "player", statFilter: "pitcher" },
  { id: "era", title: "ERA 1위", icon: <Zap size={20} />, description: "최저 방어율 투수는?", type: "player", statFilter: "pitcher" },
  { id: "last", title: "꼴찌팀", icon: <TrendingUp size={20} />, description: "올해 최하위는...?", type: "team" },
];

// 전체 선수 목록 (PLAYER_PHOTO_MAP에서 생성)
const ALL_PLAYERS = Object.entries(PLAYER_PHOTO_MAP).map(([name, id]) => {
  // 팀 매핑은 player-photos에 없으므로 빈 문자열
  return { name, playerId: id };
});

export default function PredictPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<PredictionCategory | null>(null);
  const { myPredictions, communityVotes, loading: predsLoading, savePrediction: savePredictionToDb } = usePredictions(user?.id);
  const [localPicks, setLocalPicks] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [batterStats, setBatterStats] = useState<PlayerStat[]>([]);
  const [pitcherStats, setPitcherStats] = useState<PlayerStat[]>([]);

  useEffect(() => {
    fetch("/api/stats?type=batter").then(r => r.json()).then(d => setBatterStats(d.stats || []));
    fetch("/api/stats?type=pitcher").then(r => r.json()).then(d => setPitcherStats(d.stats || []));
  }, []);

  // Merge DB predictions with local picks
  const mergedPredictions = { ...myPredictions, ...localPicks };
  const submitted = new Set(Object.keys(myPredictions));

  function savePrediction(categoryId: string, value: string) {
    setLocalPicks(prev => ({ ...prev, [categoryId]: value }));
  }

  async function submitPrediction(categoryId: string) {
    if (!user) { setShowLogin(true); return; }
    const pick = localPicks[categoryId] || mergedPredictions[categoryId];
    if (!pick) return;
    const ok = await savePredictionToDb(categoryId, pick);
    if (ok) {
      setLocalPicks(prev => { const n = {...prev}; delete n[categoryId]; return n; });
      setSelectedCategory(null);
    }
  }

  const completedCount = submitted.size;
  const totalCount = CATEGORIES.length;

  const statFilter = selectedCategory?.statFilter;
  const statsSource = statFilter === "pitcher" ? pitcherStats : statFilter === "batter" ? batterStats : [];
  const statsNames = new Set(statsSource.map((s) => s.name));
  
  const basePlayerList = statFilter
    ? ALL_PLAYERS.filter(p => statsNames.has(p.name))
    : ALL_PLAYERS;
  
  // 카테고리별 정렬
  const getSortedPlayers = (players: typeof basePlayerList) => {
    if (!selectedCategory) return players;
    const catId = selectedCategory.id;
    const source = statsSource;
    
    if (catId === "batting") {
      const sorted = [...source].sort((a, b) => parseFloat(b.avg || "0") - parseFloat(a.avg || "0"));
      const order = new Map(sorted.map((s, i) => [s.name, i]));
      return [...players].sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
    } else if (catId === "homerun") {
      const sorted = [...source].sort((a, b) => parseInt(b.hr || "0") - parseInt(a.hr || "0"));
      const order = new Map(sorted.map((s, i) => [s.name, i]));
      return [...players].sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
    } else if (catId === "wins") {
      const sorted = [...source].sort((a, b) => parseInt(b.wins || "0") - parseInt(a.wins || "0"));
      const order = new Map(sorted.map((s, i) => [s.name, i]));
      return [...players].sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
    } else if (catId === "era") {
      const sorted = [...source].filter(s => parseFloat(s.era || "99") < 90).sort((a, b) => parseFloat(a.era || "99") - parseFloat(b.era || "99"));
      const order = new Map(sorted.map((s, i) => [s.name, i]));
      return [...players].sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
    } else if (catId === "mvp") {
      // MVP: 타율 상위 (타자 기준)
      const sorted = [...source].sort((a, b) => parseFloat(b.avg || "0") - parseFloat(a.avg || "0"));
      const order = new Map(sorted.map((s, i) => [s.name, i]));
      return [...players].sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
    }
    return players;
  };

  const filteredPlayers = getSortedPlayers(
    searchQuery
      ? basePlayerList.filter(p => p.name.includes(searchQuery))
      : basePlayerList
  );
  
  // 순위 매핑
  const getRank = (name: string): string => {
    if (!statFilter || !selectedCategory) return "";
    const source = statsSource;
    const catId = selectedCategory.id;
    if (catId === "batting") {
      const sorted = [...source].sort((a, b) => parseFloat(b.avg || "0") - parseFloat(a.avg || "0"));
      const idx = sorted.findIndex(s => s.name === name);
      return idx >= 0 ? `25년 ${idx + 1}위 (${sorted[idx].avg})` : "";
    } else if (catId === "homerun") {
      const sorted = [...source].sort((a, b) => parseInt(b.hr || "0") - parseInt(a.hr || "0"));
      const idx = sorted.findIndex(s => s.name === name);
      return idx >= 0 ? `25년 ${idx + 1}위 (${sorted[idx].hr}개)` : "";
    } else if (catId === "wins") {
      const sorted = [...source].sort((a, b) => parseInt(b.wins || "0") - parseInt(a.wins || "0"));
      const idx = sorted.findIndex(s => s.name === name);
      return idx >= 0 ? `25년 ${idx + 1}위 (${sorted[idx].wins}승)` : "";
    } else if (catId === "era") {
      const sorted = [...source].filter(s => parseFloat(s.era || "99") < 90).sort((a, b) => parseFloat(a.era || "99") - parseFloat(b.era || "99"));
      const idx = sorted.findIndex(s => s.name === name);
      return idx >= 0 ? `25년 ${idx + 1}위 (${sorted[idx].era})` : "";
    }
    if (catId === "mvp") {
      const sorted = [...source].sort((a, b) => parseFloat(b.avg || "0") - parseFloat(a.avg || "0"));
      const idx = sorted.findIndex(s => s.name === name);
      return idx >= 0 ? `25년 타율 ${idx + 1}위 (${sorted[idx].avg})` : "";
    }
    return "";
  };

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      {/* Hero */}
      <div className="relative overflow-hidden px-5 pt-6 pb-5">
        <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 via-transparent to-purple-500/10" />
        <div className="relative">
          <h1 className="text-2xl font-black text-text-primary">🔮 2026 시즌 예측</h1>
          <p className="text-sm text-text-tertiary mt-1">당신의 예언을 기록하세요. 시즌 후 결과를 확인!</p>

          {/* Progress */}
          <div className="mt-4 bg-bg-tertiary rounded-full h-3 overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-amber-500 to-purple-500"
              initial={{ width: 0 }}
              animate={{ width: `${(completedCount / totalCount) * 100}%` }}
            />
          </div>
          <p className="text-xs text-text-tertiary mt-1">{completedCount}/{totalCount} 예측 완료</p>
        </div>
      </div>

      {/* Categories */}
      <div className="px-5 space-y-3">
        {CATEGORIES.map((cat, i) => {
          const isSubmitted = submitted.has(cat.id);
          const prediction = mergedPredictions[cat.id];
          const votes = communityVotes[cat.id];
          const topVote = votes ? Object.entries(votes).sort((a, b) => b[1] - a[1])[0] : null;

          return (
            <motion.div
              key={cat.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <GlassCard
                className={`p-4 cursor-pointer transition-all ${isSubmitted ? "border border-green-500/30" : "hover:bg-black/5 dark:hover:bg-white/5"}`}
                onClick={() => !isSubmitted && setSelectedCategory(cat)}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isSubmitted ? "bg-green-500/20 text-green-400" : "bg-black/8 dark:bg-white/10 text-text-secondary"}`}>
                    {isSubmitted ? <Check size={20} /> : cat.icon}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-text-primary">{cat.title}</h3>
                      {isSubmitted && prediction && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-accent/20 text-accent font-bold">
                          {cat.type === "team" ? TEAMS.find(t => String(t.id) === prediction)?.name : prediction}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-tertiary">{cat.description}</p>
                  </div>
                  {!isSubmitted && <ChevronRight size={18} className="text-text-tertiary" />}
                </div>

                {/* Community vote bar (for team predictions) */}
                {votes && topVote && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <div className="flex items-center gap-2 text-xs text-text-tertiary">
                      <span>커뮤니티 1위:</span>
                      <TeamBadge teamId={Number(topVote[0])} size="xs" />
                      <span className="font-bold text-text-secondary">
                        {TEAMS.find(t => String(t.id) === topVote[0])?.shortName}
                      </span>
                      <span>({Math.round((topVote[1] / Object.values(votes).reduce((a, b) => a + b, 0)) * 100)}%)</span>
                    </div>
                  </div>
                )}
              </GlassCard>
            </motion.div>
          );
        })}
      </div>

      {/* 리더보드 링크 */}
      <div className="px-5 mt-6">
        <GlassCard className="p-4 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5" onClick={() => router.push("/predict/leaderboard")}>
          <div className="flex items-center gap-3">
            <span className="text-2xl">🏆</span>
            <div className="flex-1">
              <h3 className="text-base font-bold text-text-primary">예측 리더보드</h3>
              <p className="text-xs text-text-tertiary">시즌 끝나면 누가 예언왕인지 확인!</p>
            </div>
            <ChevronRight size={18} className="text-text-tertiary" />
          </div>
        </GlassCard>
      </div>

      {/* Selection Modal */}
      <AnimatePresence>
        {selectedCategory && (
          <motion.div
            className="fixed inset-0 z-50 flex items-end justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0 bg-black/60" onClick={() => setSelectedCategory(null)} />
            <motion.div
              className="relative w-full max-w-lg bg-bg-secondary rounded-t-3xl max-h-[80vh] overflow-hidden flex flex-col"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25 }}
            >
              <div className="px-5 py-4 border-b border-border">
                <h2 className="text-lg font-bold text-text-primary">{selectedCategory.title} 예측</h2>
                <p className="text-sm text-text-tertiary">{selectedCategory.description}</p>
              </div>

              <div className="overflow-y-auto flex-1 px-5 py-4 pb-safe [--pb-safe-base:1rem]">
                {selectedCategory.type === "team" ? (
                  <div className="grid grid-cols-2 gap-3">
                    {TEAMS.map(team => {
                      const isSelected = mergedPredictions[selectedCategory.id] === String(team.id);
                      return (
                        <button
                          key={team.id}
                          onClick={() => savePrediction(selectedCategory.id, String(team.id))}
                          className={`flex items-center gap-3 p-3 rounded-xl transition-all ${
                            isSelected
                              ? "bg-black/8 dark:bg-white/10 ring-2 ring-accent"
                              : "bg-bg-tertiary hover:bg-black/5 dark:hover:bg-white/5"
                          }`}
                        >
                          <TeamBadge teamId={team.id} size="md" />
                          
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div>
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder="선수 이름 검색..."
                      className="w-full mb-3 px-4 py-2.5 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                    />
                    <div className="space-y-2">
                      {filteredPlayers
                        
                        .map(player => {
                          const isSelected = mergedPredictions[selectedCategory.id] === player.name;
                          return (
                            <button
                              key={player.name}
                              onClick={() => savePrediction(selectedCategory.id, player.name)}
                              className={`flex items-center gap-3 p-3 rounded-xl w-full transition-all ${
                                isSelected ? "bg-black/8 dark:bg-white/10 ring-2 ring-accent" : "bg-bg-tertiary hover:bg-black/5 dark:hover:bg-white/5"
                              }`}
                            >
                              <PlayerAvatar name={player.name} teamId={0} photoUrl={`https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/2025/${player.playerId}.jpg`} size={36} showTeamBadge={false} />
                              <div className="text-left flex-1">
                                <span className="text-sm font-bold text-text-primary">{player.name}</span>
                                {getRank(player.name) && (
                                  <p className="text-[11px] text-text-tertiary">{getRank(player.name)}</p>
                                )}
                              </div>
                              {isSelected && <Check size={16} className="ml-auto text-accent" />}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>

              <div className="px-5 py-4 border-t border-border">
                <button
                  onClick={() => submitPrediction(selectedCategory.id)}
                  disabled={!mergedPredictions[selectedCategory.id]}
                  className="w-full py-3 rounded-xl bg-accent text-white font-bold text-base disabled:opacity-30 transition-all"
                >
                  {mergedPredictions[selectedCategory.id] ? "예측 확정하기 🔮" : "선택해주세요"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
