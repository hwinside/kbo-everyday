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
  { id: "mvp", title: "정규시즌 MVP", icon: <Star size={20} />, description: "올해의 가장 빛나는 선수는?", type: "player" },
  { id: "rookie", title: "신인왕", icon: <Zap size={20} />, description: "최고의 루키는 누구?", type: "player" },
  { id: "batting", title: "타격왕", icon: <TrendingUp size={20} />, description: "최고 타율의 주인공은?", type: "player", statFilter: "batter" },
  { id: "homerun", title: "홈런왕", icon: <Trophy size={20} />, description: "가장 많은 홈런을 칠 선수는?", type: "player", statFilter: "batter" },
  { id: "wins", title: "다승왕", icon: <Star size={20} />, description: "가장 많이 이길 투수는?", type: "player", statFilter: "pitcher" },
  { id: "era", title: "ERA 1위", icon: <Zap size={20} />, description: "최저 방어율 투수는?", type: "player", statFilter: "pitcher" },
  { id: "last", title: "꼴찌팀", icon: <TrendingUp size={20} />, description: "올해 최하위는...?", type: "team" },
];

const POPULAR_PLAYERS: { name: string; team: string; teamId: number }[] = [
  { name: "김도영", team: "KIA", teamId: 6 },
  { name: "이정후", team: "키움", teamId: 10 },
  { name: "구자욱", team: "삼성", teamId: 8 },
  { name: "홍창기", team: "LG", teamId: 1 },
  { name: "오스틴", team: "LG", teamId: 1 },
  { name: "박동원", team: "LG", teamId: 1 },
  { name: "김하성", team: "키움", teamId: 10 },
  { name: "강백호", team: "KT", teamId: 3 },
  { name: "최정", team: "SSG", teamId: 4 },
  { name: "노시환", team: "한화", teamId: 9 },
  { name: "송성문", team: "키움", teamId: 10 },
  { name: "문보경", team: "롯데", teamId: 7 },
  { name: "디아즈", team: "SSG", teamId: 4 },
  { name: "로하스", team: "KT", teamId: 3 },
  { name: "나성범", team: "NC", teamId: 5 },
  { name: "양현종", team: "KIA", teamId: 6 },
  { name: "안우진", team: "KIA", teamId: 6 },
  { name: "고우석", team: "LG", teamId: 1 },
  { name: "임찬규", team: "LG", teamId: 1 },
  { name: "원태인", team: "삼성", teamId: 8 },
  { name: "문동주", team: "한화", teamId: 9 },
  { name: "박세웅", team: "롯데", teamId: 7 },
  { name: "김광현", team: "SSG", teamId: 4 },
  { name: "류현진", team: "한화", teamId: 9 },
  { name: "폰세", team: "NC", teamId: 5 },
  { name: "소형준", team: "KIA", teamId: 6 },
  { name: "페르난데스", team: "두산", teamId: 2 },
  { name: "박영현", team: "두산", teamId: 2 },
];

export default function PredictPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<PredictionCategory | null>(null);
  const [myPredictions, setMyPredictions] = useState<Record<string, string>>({});
  const [communityVotes, setCommunityVotes] = useState<Record<string, Record<string, number>>>({});
  const [submitted, setSubmitted] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  // localStorage에서 예측 로드
  useEffect(() => {
    const saved = localStorage.getItem("kbo-season-predictions-2026");
    if (saved) {
      const parsed = JSON.parse(saved);
      setMyPredictions(parsed.predictions || {});
      setSubmitted(new Set(parsed.submitted || []));
    }
    // 커뮤니티 투표 (mock)
    setCommunityVotes({
      champion: { "6": 312, "1": 287, "4": 198, "8": 145, "2": 134, "10": 98, "3": 87, "5": 76, "7": 54, "9": 43 },
      last: { "9": 287, "7": 231, "3": 156, "5": 112, "2": 98, "10": 76, "8": 54, "6": 23, "4": 19, "1": 12 },
    });
  }, []);

  function savePrediction(categoryId: string, value: string) {
    const newPreds = { ...myPredictions, [categoryId]: value };
    setMyPredictions(newPreds);
    localStorage.setItem("kbo-season-predictions-2026", JSON.stringify({
      predictions: newPreds,
      submitted: Array.from(submitted),
    }));
  }

  function submitPrediction(categoryId: string) {
    if (!user) { setShowLogin(true); return; }
    const newSubmitted = new Set(submitted);
    newSubmitted.add(categoryId);
    setSubmitted(newSubmitted);
    localStorage.setItem("kbo-season-predictions-2026", JSON.stringify({
      predictions: myPredictions,
      submitted: Array.from(newSubmitted),
    }));
    setSelectedCategory(null);
  }

  const completedCount = submitted.size;
  const totalCount = CATEGORIES.length;

  const filteredPlayers = searchQuery
    ? POPULAR_PLAYERS.filter(p => p.name.includes(searchQuery) || p.team.includes(searchQuery))
    : POPULAR_PLAYERS;

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
          const prediction = myPredictions[cat.id];
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
                className={`p-4 cursor-pointer transition-all ${isSubmitted ? "border border-green-500/30" : "hover:bg-white/5"}`}
                onClick={() => !isSubmitted && setSelectedCategory(cat)}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isSubmitted ? "bg-green-500/20 text-green-400" : "bg-white/10 text-text-secondary"}`}>
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
        <GlassCard className="p-4 cursor-pointer hover:bg-white/5" onClick={() => router.push("/predict/leaderboard")}>
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

              <div className="overflow-y-auto flex-1 px-5 py-4">
                {selectedCategory.type === "team" ? (
                  <div className="grid grid-cols-2 gap-3">
                    {TEAMS.map(team => {
                      const isSelected = myPredictions[selectedCategory.id] === String(team.id);
                      return (
                        <button
                          key={team.id}
                          onClick={() => savePrediction(selectedCategory.id, String(team.id))}
                          className={`flex items-center gap-3 p-3 rounded-xl transition-all ${
                            isSelected
                              ? "bg-white/10 ring-2 ring-accent"
                              : "bg-bg-tertiary hover:bg-white/5"
                          }`}
                        >
                          <TeamBadge teamId={team.id} size="md" />
                          <span className="text-sm font-bold text-text-primary">{team.shortName}</span>
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
                        .filter(p => !selectedCategory.statFilter || (selectedCategory.statFilter === "pitcher" ? ["양현종","안우진","고우석","임찬규","원태인","문동주","박세웅","김광현","류현진","폰세","소형준","페르난데스","박영현"].includes(p.name) : !["양현종","안우진","고우석","임찬규","원태인","문동주","박세웅","김광현","류현진","폰세","소형준","페르난데스","박영현"].includes(p.name)))
                        .map(player => {
                          const isSelected = myPredictions[selectedCategory.id] === player.name;
                          const playerId = PLAYER_PHOTO_MAP[player.name];
                          return (
                            <button
                              key={player.name}
                              onClick={() => savePrediction(selectedCategory.id, player.name)}
                              className={`flex items-center gap-3 p-3 rounded-xl w-full transition-all ${
                                isSelected ? "bg-white/10 ring-2 ring-accent" : "bg-bg-tertiary hover:bg-white/5"
                              }`}
                            >
                              {playerId && <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={`https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/2025/${playerId}.jpg`} size={36} showTeamBadge={false} />}
                              <div className="text-left">
                                <span className="text-sm font-bold text-text-primary">{player.name}</span>
                                <span className="text-xs text-text-tertiary ml-2">{player.team}</span>
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
                  disabled={!myPredictions[selectedCategory.id]}
                  className="w-full py-3 rounded-xl bg-accent text-white font-bold text-base disabled:opacity-30 transition-all"
                >
                  {myPredictions[selectedCategory.id] ? "예측 확정하기 🔮" : "선택해주세요"}
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
