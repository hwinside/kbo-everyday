"use client";

import { useParams, useSearchParams, useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";
import GlassCard from "@/components/ui/GlassCard";
import battersData from "@/lib/constants/stats-2025-batters.json";
import pitchersData from "@/lib/constants/stats-2025-pitchers.json";
import Link from "next/link";

// 스탯 정의
const STAT_DEFS: Record<string, {
  label: string;
  emoji: string;
  desc: string;
  criteria: string;
  key: string;
  type: "batter" | "pitcher";
  format?: (v: number) => string;
  higherIsBetter: boolean;
}> = {
  hr: { label: "파워히터", emoji: "💣", desc: "홈런 랭킹", criteria: "시즌 15홈런 이상이면 💣 파워히터 뱃지 획득", key: "hr", type: "batter", higherIsBetter: true },
  avg: { label: "방망이장인", emoji: "🏏", desc: "타율 랭킹", criteria: "시즌 타율 .300 이상이면 🏏 방망이장인 뱃지 획득", key: "avg", type: "batter", format: (v) => v.toFixed(3), higherIsBetter: true },
  sb: { label: "도루왕", emoji: "🏃", desc: "도루 랭킹", criteria: "시즌 20도루 이상이면 🏃 도루왕 뱃지 획득", key: "sb", type: "batter", higherIsBetter: true },
  bb: { label: "선구안", emoji: "👁️", desc: "볼넷 랭킹", criteria: "40볼넷+ & BB/K 0.5 이상이면 👁️ 선구안 뱃지 획득", key: "bb", type: "batter", higherIsBetter: true },
  obp: { label: "출루기계", emoji: "📊", desc: "출루율 랭킹", criteria: "출루율 .380 이상이면 📊 출루기계 뱃지 획득", key: "obp", type: "batter", format: (v) => v.toFixed(3), higherIsBetter: true },
  rbi: { label: "청소부", emoji: "🧹", desc: "타점 랭킹", criteria: "시즌 80타점 이상이면 🧹 청소부 뱃지 획득", key: "rbi", type: "batter", higherIsBetter: true },
  ops: { label: "OPS 괴물", emoji: "💎", desc: "OPS 랭킹", criteria: "OPS .900 이상이면 💎 OPS 괴물 뱃지 획득", key: "ops", type: "batter", format: (v) => v.toFixed(3), higherIsBetter: true },
  runs: { label: "득점기계", emoji: "🎪", desc: "득점 랭킹", criteria: "시즌 80득점 이상이면 🎪 득점기계 뱃지 획득", key: "runs", type: "batter", higherIsBetter: true },
  so_batter: { label: "삼진머신", emoji: "💀", desc: "삼진 랭킹 (타자)", criteria: "시즌 120삼진 이상이면 💀 삼진머신 뱃지 (풀스윙형)", key: "so", type: "batter", higherIsBetter: true },
  hbp: { label: "존압박", emoji: "🧲", desc: "사구 랭킹", criteria: "시즌 10사구 이상이면 🧲 존압박 뱃지 획득", key: "hbp", type: "batter", higherIsBetter: true },
  doubles: { label: "장타제조기", emoji: "🦵", desc: "2루타+3루타 랭킹", criteria: "2루타+3루타 30개 이상이면 🦵 장타제조기 뱃지 획득", key: "doubles", type: "batter", higherIsBetter: true },
  wins: { label: "에이스", emoji: "👑", desc: "승수 랭킹", criteria: "10승+ & ERA 3.50 이하이면 👑 에이스 뱃지 획득", key: "wins", type: "pitcher", higherIsBetter: true },
  era: { label: "철벽", emoji: "🛡️", desc: "ERA 랭킹", criteria: "ERA 2.50 이하 (50이닝+)이면 🛡️ 철벽 뱃지 획득", key: "era", type: "pitcher", format: (v) => v.toFixed(2), higherIsBetter: false },
  so_pitcher: { label: "탈삼진", emoji: "🔥", desc: "탈삼진 랭킹", criteria: "K/9 8.0 이상이면 🔥 탈삼진 뱃지 획득", key: "so", type: "pitcher", higherIsBetter: true },
  saves: { label: "마무리", emoji: "💪", desc: "세이브 랭킹", criteria: "시즌 20세이브 이상이면 💪 마무리 뱃지 획득", key: "saves", type: "pitcher", higherIsBetter: true },
  holds: { label: "벽", emoji: "🧱", desc: "홀드 랭킹", criteria: "시즌 20홀드 이상이면 🧱 벽 뱃지 획득", key: "holds", type: "pitcher", higherIsBetter: true },
  ip: { label: "이닝이터", emoji: "🏔️", desc: "이닝 랭킹", criteria: "시즌 150이닝 이상이면 🏔️ 이닝이터 뱃지 획득", key: "ip", type: "pitcher", format: (v) => v.toFixed(1), higherIsBetter: true },
  whip: { label: "포커페이스", emoji: "🧊", desc: "WHIP 랭킹", criteria: "WHIP 1.10 이하 (50이닝+)이면 🧊 포커페이스 뱃지 획득", key: "whip", type: "pitcher", format: (v) => v.toFixed(2), higherIsBetter: false },
  games_pitcher: { label: "불펜철인", emoji: "🔋", desc: "등판수 랭킹", criteria: "시즌 60경기 이상 등판이면 🔋 불펜철인 뱃지 획득", key: "games", type: "pitcher", higherIsBetter: true },
};

function RankingContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const stat = params.stat as string;
  const highlightPlayer = searchParams.get("player");
  const highlightRef = useRef<HTMLDivElement>(null);
  
  const [players, setPlayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  const def = STAT_DEFS[stat];
  
  useEffect(() => {
    if (!def) return;
    const data: any[] = def.type === "batter" ? battersData : pitchersData;
    const filtered = def.type === "batter" 
      ? data.filter(p => (p.games || 0) >= 30)
      : data.filter(p => (p.games || 0) >= 10);
    
    const sorted = [...filtered].sort((a, b) => {
      let aVal = parseFloat(a[def.key]) || 0;
      let bVal = parseFloat(b[def.key]) || 0;
      if (stat === "doubles") {
        aVal = (a.doubles || 0) + (a.triples || 0);
        bVal = (b.doubles || 0) + (b.triples || 0);
      }
      return def.higherIsBetter ? bVal - aVal : aVal - bVal;
    });
    
    setPlayers(sorted.slice(0, 50));
    setLoading(false);
  }, [stat, def]);
  
  useEffect(() => {
    if (highlightRef.current) {
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 300);
    }
  }, [players]);
  
  if (!def) {
    return (
      <div className="min-h-screen bg-bg-primary text-text-primary px-5 pt-safe">
        <div className="py-3 flex items-center gap-3">
          <button onClick={() => router.back()} className="text-xl">←</button>
          <h1 className="text-lg font-bold">알 수 없는 스탯</h1>
        </div>
      </div>
    );
  }
  
  const getValue = (p: any) => {
    if (stat === "doubles") return (p.doubles || 0) + (p.triples || 0);
    return parseFloat(p[def.key]) || 0;
  };
  
  const formatValue = (v: number) => def.format ? def.format(v) : String(v);
  
  return (
    <div className="min-h-screen bg-bg-primary text-text-primary px-5 pt-safe pb-24">
      {/* Header */}
      <div className="py-3 flex items-center gap-3">
        <button onClick={() => router.back()} className="text-xl">←</button>
        <h1 className="text-3xl font-extrabold tracking-tight">{def.emoji} {def.desc}</h1>
      </div>
      
      {/* 뱃지 설명 */}
      <GlassCard className="p-4 mb-6">
        <p className="text-sm text-text-secondary">{def.criteria}</p>
      </GlassCard>
      
      {/* 랭킹 리스트 */}
      {loading ? (
        <div className="text-center py-20 text-text-tertiary">로딩 중...</div>
      ) : (
        <div className="space-y-2">
          {players.map((p, i) => {
            const isHighlight = highlightPlayer && (p.kboId === highlightPlayer || p.playerId === highlightPlayer);
            const val = getValue(p);
            const teamId = p.teamId || 0;
            
            return (
              <div
                key={p.kboId || p.playerId || i}
                ref={isHighlight ? highlightRef : undefined}
              >
                <Link href={`/boards/players/${p.kboId || p.playerId}`}>
                  <GlassCard
                    pressable
                    className={`p-3 flex items-center gap-3 ${
                      isHighlight ? "ring-2 ring-accent" : ""
                    }`}
                  >
                    {/* 순위 */}
                    <span className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold flex-shrink-0 ${
                      i === 0 ? "bg-yellow-500/20 text-yellow-400" :
                      i === 1 ? "bg-gray-400/20 text-gray-300" :
                      i === 2 ? "bg-amber-700/20 text-amber-600" :
                      "bg-bg-tertiary text-text-tertiary"
                    }`}>
                      {i + 1}
                    </span>
                    
                    {/* 선수 */}
                    <PlayerAvatar name={p.name} teamId={teamId} photoUrl={getPlayerPhotoUrl(p.name)} size={44} />
                    
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-text-primary">{p.name}</span>
                      <span className="ml-1.5 text-xs text-text-tertiary">{p.team}</span>
                    </div>
                    
                    {/* 스탯 값 */}
                    <span className="text-lg font-bold tabular-nums" style={{ color: isHighlight ? (TEAMS.find(t => t.id === teamId)?.colorLight || "#FF6B35") : undefined }}>
                      {formatValue(val)}
                    </span>
                  </GlassCard>
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function RankingPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg-primary" />}>
      <RankingContent />
    </Suspense>
  );
}
