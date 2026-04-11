"use client";

import { useParams, useSearchParams, useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";
import GlassCard from "@/components/ui/GlassCard";
import { getMyTeamId } from "@/lib/store/myteam";
import { getFavoritePlayers } from "@/lib/store/favorites";
import { useAuth } from "@/lib/supabase/AuthContext";

import Link from "next/link";

function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace("#", "");
  const full = cleaned.length === 3
    ? cleaned.split("").map((c) => c + c).join("")
    : cleaned;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getTeamColor(teamId: number): string {
  return TEAMS.find((t) => t.id === teamId)?.colorPrimary || "#FF6B35";
}

function getTeamIdFromTeamText(team?: string): number | null {
  if (!team) return null;
  // stats JSON은 "LG" 같은 shortName을 사용
  const found = TEAMS.find((t) => t.shortName === team || t.name === team);
  return found?.id ?? null;
}

type StatType = "batter" | "pitcher";

type PlayerRow = {
  kboId?: string;
  playerId?: string;
  name: string;
  team?: string;
  teamId?: number;
  games?: number;
  doubles?: number;
  triples?: number;
  rank?: number;
  [key: string]: unknown;
};

// 스탯 정의
const STAT_DEFS: Record<string, {
  label: string;
  emoji: string;
  desc: string;
  criteria: string;
  key: string;
  type: StatType;
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
  games_batter: { label: "풀타임", emoji: "🔋", desc: "출전경기 랭킹", criteria: "시즌 140경기 이상 출전이면 🔋 풀타임 뱃지 획득", key: "games", type: "batter", higherIsBetter: true },
  games_pitcher: { label: "불펜철인", emoji: "🔋", desc: "등판수 랭킹", criteria: "시즌 60경기 이상 등판이면 🔋 불펜철인 뱃지 획득", key: "games", type: "pitcher", higherIsBetter: true },
};

function RankingContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { profile } = useAuth();
  const stat = params.stat as string;
  const highlightPlayer = searchParams.get("player");
  const highlightRef = useRef<HTMLDivElement>(null);

  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [loading, setLoading] = useState(true);

  // DB 프로필 > localStorage 폴백 (앱 재설치 시 localStorage 초기화 대응)
  const myTeamId = useMemo(() => {
    return profile?.team_id ?? getMyTeamId();
  }, [profile]);

  const { favoriteIdSet, favoriteNameSet } = useMemo(() => {
    const dbFavs = profile?.favorite_players as { playerId?: string; name?: string }[] | undefined;
    const favs = dbFavs?.length ? dbFavs.slice(0, 5) : getFavoritePlayers().slice(0, 5);
    return {
      favoriteIdSet: new Set(favs.map((f) => String(f.playerId || "")).filter(Boolean)),
      favoriteNameSet: new Set(favs.map((f) => f.name || "").filter(Boolean)),
    };
  }, [profile]);

  const def = STAT_DEFS[stat];

  useEffect(() => {
    if (!def) return;
    const type = def.type === "batter" ? "batter" : "pitcher";

    fetch(`/api/stats?type=${type}&season=2026`)
      .then((r) => r.json())
      .then((data: { stats?: PlayerRow[] }) => {
        const rows: PlayerRow[] = data.stats || [];
        // 비율 스탯 필터링:
        // - 타자: avg/obp/ops/slg → 최소 30타석 (시즌 초 기준)
        // - 투수: era/whip → 최소 12이닝 (KBO 공식 규정이닝 기준, 시즌 초반)
        // 누적 스탯(hr/rbi/wins/so 등)은 최소 경기수만 체크
        const parseIP = (ip: string | number): number => {
          if (typeof ip === "number") return ip;
          const s = String(ip).trim();
          const match = s.match(/^(\d+)(?:\s+(\d+)\/(\d+))?$/);
          if (!match) return 0;
          const whole = parseInt(match[1]) || 0;
          const frac = match[2] && match[3] ? parseInt(match[2]) / parseInt(match[3]) : 0;
          return whole + frac;
        };
        const isRateStat = ["avg", "era", "obp", "ops", "whip"].includes(stat);
        const filtered = isRateStat
          ? def.type === "batter"
            ? rows.filter((p) => (Number(p['pa']) || 0) >= 30) // 타자: 최소 30타석
            : rows.filter((p) => parseIP((p['ip'] as string | number) || 0) >= 12) // 투수: 최소 12이닝
          : def.type === "batter"
            ? rows.filter((p) => (p.games || 0) >= 10)
            : rows.filter((p) => (p.games || 0) >= 5);

        const sorted = [...filtered].sort((a, b) => {
          let aVal = Number(a[def.key] ?? 0) || 0;
          let bVal = Number(b[def.key] ?? 0) || 0;
          if (stat === "doubles") {
            aVal = (a.doubles || 0) + (a.triples || 0);
            bVal = (b.doubles || 0) + (b.triples || 0);
          }
          return def.higherIsBetter ? bVal - aVal : aVal - bVal;
        });

        // 공동 순위 적용 (competition ranking: 같은 값이면 같은 rank, 다음 순위는 건너뛰기)
        const withRank: PlayerRow[] = sorted.map((p, i) => {
          let currentVal = Number(p[def.key] ?? 0) || 0;
          if (stat === "doubles") {
            currentVal = (p.doubles || 0) + (p.triples || 0);
          }
          let rank = 1;
          if (i > 0) {
            let prevVal = Number(sorted[i - 1][def.key] ?? 0) || 0;
            if (stat === "doubles") {
              prevVal = (sorted[i - 1].doubles || 0) + (sorted[i - 1].triples || 0);
            }
            if (currentVal === prevVal) {
              rank = sorted[i - 1].rank || i;
            } else {
              rank = i + 1;
            }
          }
          return { ...p, rank };
        });

        setPlayers(withRank.slice(0, 100));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [stat, def]);

  useEffect(() => {
    if (highlightRef.current) {
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 300);
    }
  }, [players]);

  const legendItems = useMemo(() => {
    const items: { key: string; label: string }[] = [];
    if (highlightPlayer) items.push({ key: "l3", label: "🔗 선택된 선수" });
    items.push({ key: "l2", label: "★ 최애" });
    items.push({ key: "l1", label: "내 팀" });
    return items;
  }, [highlightPlayer]);

  if (!def) {
    return (
      <div className="min-h-screen bg-bg-primary text-text-primary px-5 pt-safe">
        <div className="py-3 flex items-center gap-3">
          <button onClick={() => router.back()} className="text-xl">←</button>
          <h1 className="text-lg font-bold">알 수 없는 기록</h1>
        </div>
      </div>
    );
  }

  const getValue = (p: PlayerRow) => {
    if (stat === "doubles") return (p.doubles || 0) + (p.triples || 0);
    return Number(p[def.key] ?? 0) || 0;
  };

  const formatValue = (v: number) => (def.format ? def.format(v) : String(v));

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary px-5 pt-safe pb-24">
      {/* Header */}
      <div className="py-3 flex items-center gap-3">
        <button onClick={() => router.back()} className="text-xl">←</button>
        <h1 className="text-2xl font-bold tracking-tight">{def.emoji} {def.desc}</h1>
      </div>

      {/* 뱃지 설명 */}
      <GlassCard className="p-4 mb-3">
        <p className="text-sm text-text-secondary">{def.criteria}</p>
      </GlassCard>

      {/* Legend */}
      <div className="mb-6 text-xs text-text-tertiary flex flex-wrap gap-x-3 gap-y-1">
        {legendItems.map((it) => (
          <span key={it.key} className="inline-flex items-center gap-1">
            <span className="opacity-80">•</span>
            <span>{it.label}</span>
          </span>
        ))}
      </div>

      {/* 랭킹 리스트 */}
      {loading ? (
        <div className="text-center py-20 text-text-tertiary">로딩 중...</div>
      ) : (
        <div className="space-y-2">
          {highlightPlayer &&
            !players.some((p) =>
              p.kboId === highlightPlayer ||
              p.playerId === highlightPlayer ||
              p.name === decodeURIComponent(highlightPlayer)
            ) && (
              <GlassCard className="p-4 mb-4 border border-accent/30">
                <p className="text-sm text-text-secondary text-center">
                  해당 선수는 현재 Top {players.length} 밖에 위치해 있습니다
                </p>
              </GlassCard>
            )}

          {players.map((p, i) => {
            const isUrlHighlight =
              !!highlightPlayer &&
              (p.kboId === highlightPlayer ||
                p.playerId === highlightPlayer ||
                p.name === decodeURIComponent(highlightPlayer));

            const val = getValue(p);
            const teamId =
              (typeof p.teamId === "number" ? p.teamId : null) ??
              getTeamIdFromTeamText(p.team) ??
              0;

            const isMyTeam = myTeamId != null && teamId === myTeamId;
            const playerKey = String(p.kboId || p.playerId || "");
            const isFavorite = favoriteIdSet.has(playerKey) || favoriteNameSet.has(p.name);

            // Priority: L3(URL) > L2(favorite) > L1(my team)
            const highlightLevel = isUrlHighlight ? 3 : isFavorite ? 2 : isMyTeam ? 1 : 0;

            const teamColor = getTeamColor(teamId);

            const cardStyle: CSSProperties | undefined =
              highlightLevel === 0
                ? undefined
                : highlightLevel === 3
                  ? undefined
                  : {
                      borderLeft: `${highlightLevel === 2 ? 4 : 3}px solid ${hexToRgba(teamColor, highlightLevel === 2 ? 1 : 0.8)}`,
                      backgroundColor: hexToRgba(teamColor, highlightLevel === 2 ? 0.18 : 0.12),
                    };

            return (
              <div key={p.kboId || p.playerId || i} ref={isUrlHighlight ? highlightRef : undefined}>
                <Link href={`/community/players/${p.kboId || p.playerId || p.name}`}>
                  <GlassCard
                    pressable
                    className={`p-3 flex items-center gap-3 ${
                      highlightLevel === 3 ? "ring-2 ring-accent bg-black/8 dark:bg-white/10" : ""
                    }`}
                    style={cardStyle}
                  >
                    {/* 순위 */}
                    <span
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold flex-shrink-0 ${
                        (p.rank || i + 1) === 1
                          ? "bg-yellow-500/20 text-yellow-400"
                          : (p.rank || i + 1) === 2
                            ? "bg-gray-400/20 text-gray-300"
                            : (p.rank || i + 1) === 3
                              ? "bg-amber-700/20 text-amber-600"
                              : "bg-bg-tertiary text-text-tertiary"
                      }`}
                    >
                      {p.rank || i + 1}
                    </span>

                    {/* 선수 */}
                    <PlayerAvatar
                      name={p.name}
                      teamId={teamId}
                      photoUrl={getPlayerPhotoUrl(p.name, p.kboId || p.playerId)}
                      size={44}
                    />

                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-text-primary">
                        {p.name}
                        {highlightLevel === 2 && (
                          <span className="ml-1" role="img" aria-label="최애 선수">
                            ★
                          </span>
                        )}
                      </span>
                      <span className="ml-1.5 text-xs text-text-tertiary">{p.team}</span>
                    </div>

                    {/* 스탯 값 */}
                    <span
                      className="text-lg font-bold tabular-nums"
                      style={{
                        color:
                          highlightLevel > 0
                            ? TEAMS.find((t) => t.id === teamId)?.colorLight || "#FF6B35"
                            : undefined,
                      }}
                    >
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
