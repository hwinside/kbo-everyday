"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getCanonicalPlayerHref } from "@/lib/utils/resolve-player";
import { TEAMS } from "@/lib/constants/teams";
import GlassCard from "@/components/ui/GlassCard";
import { getMyTeamId } from "@/lib/store/myteam";
import { getFavoritePlayers } from "@/lib/store/favorites";
import { useAuth } from "@/lib/supabase/AuthContext";
import { STAT_DEFS } from "@/lib/stats/title-defs";
import { rankByStat } from "@/lib/stats/title-rankings";

import Link from "next/link";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";

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

function RankingContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const goBack = useSafeBack("/");
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
        // 자격 필터 + 정렬 + 공동순위 = 공용 rankByStat (홈 최애선수 카드 타이틀과 동일 SSOT)
        const withRank = rankByStat(rows, stat) as PlayerRow[];
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
        <div className="min-h-[44px] flex items-center gap-3">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center -ml-2 text-xl">←</button>
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
    <div className="min-h-screen bg-bg-primary text-text-primary px-5 pb-24">
      {/* Header */}
      <div className="sticky top-0 z-30 -mx-5 border-b border-border bg-bg-primary px-5" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <div className="min-h-[44px] flex items-center gap-3">
        <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center -ml-2 text-xl">←</button>
        <h1 className="text-lg font-bold tracking-tight flex-1">{def.emoji} {def.desc}</h1>
        <HeaderProfileLink />
      </div>
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

            const playerHref = getCanonicalPlayerHref({
              name: p.name,
              kboId: p.kboId,
              playerId: p.playerId,
              teamId,
            }) ?? `/community/players/${p.kboId || p.playerId || p.name}`;

            return (
              <div key={p.kboId || p.playerId || i} ref={isUrlHighlight ? highlightRef : undefined}>
                <Link href={playerHref} prefetch={false}>
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
                      photoUrl={getPlayerPhotoUrl(p.name, p.kboId || p.playerId, teamId)}
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
