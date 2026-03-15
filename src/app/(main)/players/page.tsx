"use client";

import { Search, ChevronDown, ChevronLeft } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import Link from "next/link";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { useState, useMemo, useEffect, useCallback, useRef, startTransition } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { TEAMS, getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { getMyTeamId } from "@/lib/store/myteam";
import TeamBadge from "@/components/ui/TeamBadge";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import playersRoster from "@/lib/constants/players-roster.json";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";

interface PlayerItem {
  name: string;
  kboId: string;
  teamId: number;
  team: string;
  position: string;
  backNo: string;
}

const PLAYERS: PlayerItem[] = playersRoster as PlayerItem[];

type FilterMode = "all" | "team" | "position";
type SortMode = "name" | "posts" | "photos";

const POSITIONS = ["투수", "포수", "내야수", "외야수"];

const SORT_LABELS: Record<SortMode, string> = {
  name: "가나다순",
  posts: "게시글수",
  photos: "직찍수",
};

function sortPlayers(players: PlayerItem[], mode: SortMode): PlayerItem[] {
  const sorted = [...players];
  switch (mode) {
    case "name":
      return sorted.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    case "posts":
      // TODO(Phase 2): fetch post counts per player from Supabase (board_type='player'), then sort by count desc. Falls back to name sort for now.
      return sorted.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    case "photos":
      // TODO(Phase 2): fetch photo post counts per player from Supabase (content_type='photo'), then sort by count desc. Falls back to name sort for now.
      return sorted.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    default:
      return sorted;
  }
}

function PlayersPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [myTeamId, setMyTeamId] = useState<number | null>(null);
  useEffect(() => { startTransition(() => setMyTeamId(getMyTeamId())); }, []);

  const [filterMode, setFilterMode] = useState<FilterMode>(
    (searchParams.get("mode") as FilterMode) || "all"
  );
  const [filterTeam, setFilterTeam] = useState<number | null>(
    searchParams.get("team") ? Number(searchParams.get("team")) : null
  );
  const [filterPosition, setFilterPosition] = useState<string | null>(
    searchParams.get("pos") || null
  );
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") || "");
  const [sortMode, setSortMode] = useState<SortMode>(
    (searchParams.get("sort") as SortMode) || "name"
  );
  const [visibleCount, setVisibleCount] = useState(20);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    let result = PLAYERS;

    if (filterMode === "team" && filterTeam) {
      result = result.filter(p => p.teamId === filterTeam);
    }
    if (filterMode === "position" && filterPosition) {
      result = result.filter(p => p.position === filterPosition);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.team.toLowerCase().includes(q) ||
        p.position.includes(q)
      );
    }

    return sortPlayers(result, sortMode);
  }, [filterMode, filterTeam, filterPosition, searchQuery, sortMode]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount(v => v + 20);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleCount, filtered.length]);

  // URL 쿼리 파라미터 동기화
  useEffect(() => {
    const params = new URLSearchParams();
    if (filterMode !== "all") params.set("mode", filterMode);
    if (filterTeam) params.set("team", String(filterTeam));
    if (filterPosition) params.set("pos", filterPosition);
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    if (sortMode !== "name") params.set("sort", sortMode);
    const qs = params.toString();
    const newUrl = qs ? `/players?${qs}` : "/players";
    router.replace(newUrl, { scroll: false });
  }, [filterMode, filterTeam, filterPosition, searchQuery, sortMode, router]);

  function handleFilterMode(mode: FilterMode) {
    setFilterMode(mode);
    setFilterTeam(null);
    setFilterPosition(null);
    setVisibleCount(20);
  }

  return (
    <div className="mx-auto max-w-lg px-5">
      {/* Header */}
      <div className="border-b -mx-5 px-5" style={{ borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)' }}>
        <header className="py-3 flex items-center gap-3">
          <button onClick={() => router.back()} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors"><ChevronLeft size={24} /></button>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight flex-1">선수</h1>
          <HeaderProfileLink />
        </header>
      </div>

      {/* 검색 */}
      <div className="mt-2 mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            placeholder="선수 이름, 팀, 포지션 검색"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setVisibleCount(20);
            }}
            className="w-full rounded-xl bg-bg-secondary py-3 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      {/* Level 1: 필터 모드 */}
      <div className="mb-2 flex gap-2">
        {([["all", "전체"], ["team", "구단별"], ["position", "포지션별"]] as [FilterMode, string][]).map(
          ([mode, label]) => (
            <button
              key={mode}
              onClick={() => handleFilterMode(mode)}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all ${
                filterMode === mode
                  ? "bg-accent text-white"
                  : "bg-bg-tertiary text-text-tertiary"
              }`}
            >
              {label}
            </button>
          )
        )}
      </div>

      {/* Level 2: 구단 또는 포지션 */}
      {filterMode === "team" && (
        <div className="mb-3 flex gap-2 overflow-x-auto hide-scrollbar pb-1">
          <button
            onClick={() => { setFilterTeam(null); setVisibleCount(20); }}
            className={`shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              !filterTeam ? "bg-white/15 text-text-primary" : "bg-bg-secondary/50 text-text-tertiary"
            }`}
          >
            전체
          </button>
          {TEAMS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setFilterTeam(t.id); setVisibleCount(20); }}
              className={`shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                filterTeam === t.id ? "text-white" : "bg-bg-secondary/50 text-text-tertiary"
              }`}
              style={filterTeam === t.id ? { backgroundColor: getTeamBgColor(t) } : undefined}
            >
              {t.shortName}
            </button>
          ))}
        </div>
      )}
      {filterMode === "position" && (
        <div className="mb-3 flex gap-2 pb-1">
          <button
            onClick={() => { setFilterPosition(null); setVisibleCount(20); }}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              !filterPosition ? "bg-white/15 text-text-primary" : "bg-bg-secondary/50 text-text-tertiary"
            }`}
          >
            전체
          </button>
          {POSITIONS.map((pos) => (
            <button
              key={pos}
              onClick={() => { setFilterPosition(pos); setVisibleCount(20); }}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                filterPosition === pos
                  ? "bg-white/15 text-text-primary"
                  : "bg-bg-secondary/50 text-text-tertiary"
              }`}
            >
              {pos}
            </button>
          ))}
        </div>
      )}

      {/* 소팅 + 결과 수 */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-text-tertiary">
          {searchQuery ? `검색 결과 ${filtered.length}명` : `${filtered.length}명`}
        </span>
        <div className="flex gap-1">
          {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => { setSortMode(mode); setVisibleCount(20); }}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                sortMode === mode
                  ? "bg-black/8 dark:bg-white/10 text-text-primary"
                  : "text-text-tertiary"
              }`}
            >
              {SORT_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      {/* 선수 목록 */}
      <div className="space-y-2 pb-24">
        {filtered.slice(0, visibleCount).map((player, i) => (
          <Link key={player.kboId || i} href={`/community/players/${player.kboId}`}>
            <div className="flex items-center gap-3 rounded-xl bg-bg-secondary/50 px-4 py-3 active:bg-bg-tertiary transition-colors">
              <PlayerAvatar
                name={player.name}
                teamId={player.teamId}
                photoUrl={getPlayerPhotoUrl(player.name, player.kboId)}
                size={48}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">
                    {player.name}
                  </span>
                  <TeamBadge teamId={player.teamId} size="xs" />
                </div>
                <p className="text-xs text-text-tertiary mt-0.5">
                  #{player.backNo} · {player.position}
                </p>
              </div>
              <ChevronDown className="h-4 w-4 text-text-tertiary -rotate-90 shrink-0" />
            </div>
          </Link>
        ))}

        {visibleCount < filtered.length && (
          <div ref={loadMoreRef} className="w-full py-4 mt-2 flex justify-center">
            <div className="w-6 h-6 border-2 border-text-tertiary border-t-accent rounded-full animate-spin" />
          </div>
        )}

        {filtered.length === 0 && (
          <div className="text-center py-12 text-text-tertiary text-sm">
            검색 결과가 없습니다
          </div>
        )}
      </div>
    </div>
  );
}

import { Suspense } from "react";

export default function PlayersPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-lg px-5 py-10 text-center text-text-tertiary">로딩중...</div>}>
      <PlayersPageContent />
    </Suspense>
  );
}
