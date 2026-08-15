"use client";

import { Search, ChevronDown, ChevronLeft } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import Link from "next/link";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { useState, useMemo, useEffect, useRef, useCallback, startTransition } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { TEAMS, getTeamBgColor } from "@/lib/constants/teams";
import { getMyTeamId } from "@/lib/store/myteam";
import TeamBadge from "@/components/ui/TeamBadge";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import playersRosterStatic from "@/lib/constants/players-roster.json";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { matchHangul } from "@/lib/utils/hangul-search";
import {
  normalizePopularityCounts,
  sortPlayersByPopularity,
  type PopularityCounts,
} from "@/lib/utils/player-popularity";

interface PlayerItem {
  name: string;
  kboId: string;
  teamId: number;
  team: string;
  position: string;
  backNo: string;
}

const STATIC_PLAYERS: PlayerItem[] = playersRosterStatic as PlayerItem[];

type FilterMode = "all" | "team" | "position";

/**
 * 정렬 축은 인기순(최애선수 지정 계정 수)·가나다순 둘뿐이다.
 *
 * 기존 "게시글수"·"직찍수" 토글은 집계가 구현되지 않아 두 갈래 모두 가나다순으로
 * 폴백되고 있었다(= 눌러도 목록이 그대로). 동작하지 않는 UI를 노출하는 대신
 * 제거하고, 실제로 집계가 있는 인기순을 기본값으로 둔다.
 */
const SORT_MODES = ["popularity", "name"] as const;
type SortMode = (typeof SORT_MODES)[number];

const DEFAULT_SORT: SortMode = "popularity";

const POSITIONS = ["투수", "포수", "내야수", "외야수"];

const SORT_LABELS: Record<SortMode, string> = {
  popularity: "인기순",
  name: "가나다순",
};

/**
 * URL `?sort=` 를 정규화한다. 제거된 값(posts·photos)이나 오타는 기본값으로 되돌린다.
 * 이전에 공유된 `?sort=posts` 링크가 404 스러운 빈 상태가 되지 않게 하는 것이 목적.
 */
function parseSortMode(raw: string | null): SortMode {
  return (SORT_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as SortMode)
    : DEFAULT_SORT;
}

function sortPlayers(
  players: PlayerItem[],
  mode: SortMode,
  popularity: PopularityCounts,
): PlayerItem[] {
  if (mode === "popularity") {
    // 지정 계정 수 desc, 동률(0명끼리 포함)은 가나다순 — 온보딩 선수 선택과 같은 계약.
    // counts 가 비면 전원 0 이 되어 자연스럽게 가나다순이 된다(집계 실패해도 목록은 유지).
    return sortPlayersByPopularity(
      players.map((p) => ({ ...p, id: p.kboId })),
      popularity,
    );
  }
  return [...players].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

function PlayersPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const goBack = useSafeBack("/");

  // Supabase roster 로딩 (fallback: 정적 JSON)
  const [players, setPlayers] = useState<PlayerItem[]>(STATIC_PLAYERS);
  useEffect(() => {
    fetch("/api/roster")
      .then((res) => res.json())
      .then((data: PlayerItem[]) => {
        if (Array.isArray(data) && data.length > 0) setPlayers(data);
      })
      .catch(() => { /* fallback to static */ });
  }, []);

  // URL 파라미터가 없으면 지정팀 기본 적용
  const hasUrlMode = searchParams.has("mode");
  const hasUrlTeam = searchParams.has("team");

  const [filterMode, setFilterMode] = useState<FilterMode>(
    (searchParams.get("mode") as FilterMode) || "all"
  );
  const [filterTeam, setFilterTeam] = useState<number | null>(
    searchParams.get("team") ? Number(searchParams.get("team")) : null
  );

  const [myTeamId, setMyTeamId] = useState<number | null>(null);

  // 유저가 필터를 직접 만졌으면 그 뒤에 마이팀이 도착해도 화면을 빼앗지 않는다.
  // (늦게 온 기본값이 유저 선택을 덮으면 그게 더 나쁜 버그다)
  const filterTouchedRef = useRef(false);

  useEffect(() => {
    // 마이팀은 마운트 시 한 번만 읽으면 놓친다.
    //
    // 로그인 유저의 마이팀은 AuthContext 가 프로필 응답을 받은 뒤에야
    // setMyTeamId(profile.team_id) 로 채워진다. 그 시점엔 이 페이지가 이미
    // 마운트를 끝낸 뒤라, 한 번만 읽는 구조에서는 마이팀이 영영 반영되지 않는다
    // (2026-08-15 Production 실측: 마운트 후 team-changed 가 와도 전체 883명 고정).
    // 그래서 team-changed(같은 탭) + storage(다른 탭) 를 구독해 늦게 온 값도 받는다.
    const apply = () => {
      const teamId = getMyTeamId();
      if (teamId === null) return;
      startTransition(() => {
        setMyTeamId(teamId);
        // URL 로 명시된 필터와 유저가 직접 만진 필터는 건드리지 않는다.
        if (!hasUrlMode && !hasUrlTeam && !filterTouchedRef.current) {
          setFilterMode("team");
          setFilterTeam(teamId);
        }
      });
    };
    apply();
    window.addEventListener("team-changed", apply);
    window.addEventListener("storage", apply);
    return () => {
      window.removeEventListener("team-changed", apply);
      window.removeEventListener("storage", apply);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [filterPosition, setFilterPosition] = useState<string | null>(
    searchParams.get("pos") || null
  );
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") || "");
  const [sortMode, setSortMode] = useState<SortMode>(() =>
    parseSortMode(searchParams.get("sort"))
  );

  // 최애선수 지정 수 집계.
  //
  // 빈 counts 로 먼저 그려버리면 "인기순" 상태에서 가나다순 목록이 보이다가
  // 집계가 도착하는 시점(Production 실측 ~339ms)에 행이 통째로 재정렬된다.
  // 그 사이에 터치하면 의도하지 않은 선수로 들어간다 — 온보딩 선수 선택과 같은
  // bounded settle 로 닫는다: 먼저 끝난 쪽(응답 또는 timeout)이 이기고, 늦게 온 응답은 무시한다.
  const [popularity, setPopularity] = useState<PopularityCounts>({});
  const [popularityStatus, setPopularityStatus] = useState<"loading" | "ready">("loading");
  useEffect(() => {
    let stale = false;
    let settled = false;
    // 집계가 느리거나 죽어도 목록을 영원히 막지 않는다 — 빈 counts 로 가나다순 확정.
    const timeout = window.setTimeout(() => {
      if (stale || settled) return;
      settled = true;
      setPopularityStatus("ready");
    }, 1200);
    fetch("/api/player-popularity")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (stale || settled) return;
        settled = true;
        setPopularity(normalizePopularityCounts(json?.counts));
        setPopularityStatus("ready");
      })
      .catch(() => {
        // 실패해도 목록은 나와야 한다(counts 빈 상태 → 가나다순).
        if (stale || settled) return;
        settled = true;
        setPopularityStatus("ready");
      });
    return () => { stale = true; window.clearTimeout(timeout); };
  }, []);
  const [visibleCount, setVisibleCount] = useState(20);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const loadMoreObserverRef = useRef<IntersectionObserver | null>(null);

  const filtered = useMemo(() => {
    let result = players;

    if (filterMode === "team" && filterTeam) {
      result = result.filter(p => p.teamId === filterTeam);
    }
    if (filterMode === "position" && filterPosition) {
      result = result.filter(p => p.position === filterPosition);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim();
      result = result.filter(p =>
        matchHangul(p.name, q) ||
        matchHangul(p.team, q) ||
        matchHangul(p.position, q)
      );
    }

    return sortPlayers(result, sortMode, popularity);
  }, [players, filterMode, filterTeam, filterPosition, searchQuery, sortMode, popularity]);

  // 동명이인 감지: 이름이 같은 선수가 2명 이상이면 Set에 추가
  const duplicateNames = useMemo(() => {
    const nameCount: Record<string, number> = {};
    for (const p of filtered) {
      nameCount[p.name] = (nameCount[p.name] || 0) + 1;
    }
    return new Set(Object.entries(nameCount).filter(([, c]) => c > 1).map(([n]) => n));
  }, [filtered]);

  // 옵저버는 effect deps 가 아니라 **노드 부착 시점**에 건다.
  //
  // sentinel 은 조건부로 마운트된다(인기순은 집계 settle 전까지 목록 대신
  // 플레이스홀더를 그리고, 그 동안 sentinel 자체가 DOM 에 없다). ref + effect
  // 조합은 "마운트 조건"과 "effect deps" 가 어긋나면 옵저버가 영영 안 붙는다 —
  // status 가 loading→ready 로 바뀌어 sentinel 이 처음 붙는 렌더에서 deps 가
  // 그대로면 effect 가 재실행되지 않아 무한 스피너가 된다.
  // callback ref 는 노드가 붙고/떨어질 때 React 가 직접 호출하므로 그 불일치가
  // 구조적으로 성립하지 않는다.
  const attachLoadMore = useCallback((node: HTMLDivElement | null) => {
    loadMoreObserverRef.current?.disconnect();
    loadMoreObserverRef.current = null;
    loadMoreRef.current = node;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount(v => v + 20);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(node);
    loadMoreObserverRef.current = observer;
  }, []);

  // 언마운트 정리(페이지 이탈 시 옵저버 누수 방지).
  useEffect(() => () => {
    loadMoreObserverRef.current?.disconnect();
    loadMoreObserverRef.current = null;
  }, []);

  // URL 쿼리 파라미터 동기화
  useEffect(() => {
    const params = new URLSearchParams();
    if (filterMode !== "all") params.set("mode", filterMode);
    if (filterTeam) params.set("team", String(filterTeam));
    if (filterPosition) params.set("pos", filterPosition);
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    if (sortMode !== DEFAULT_SORT) params.set("sort", sortMode);
    const qs = params.toString();
    const newUrl = qs ? `/players?${qs}` : "/players";
    router.replace(newUrl, { scroll: false });
  }, [filterMode, filterTeam, filterPosition, searchQuery, sortMode, router]);

  function handleFilterMode(mode: FilterMode) {
    filterTouchedRef.current = true;
    setFilterMode(mode);
    setFilterTeam(null);
    setFilterPosition(null);
    setVisibleCount(20);
  }

  return (
    <div className="mx-auto max-w-lg px-5">
      {/* Header */}
      <div className="sticky top-0 z-30 border-b -mx-5 px-5 bg-bg-primary" style={{ borderColor: myTeamId ? getTeamBorderColorById(myTeamId) : 'var(--color-border)', paddingTop: "env(safe-area-inset-top, 0px)", marginTop: "calc(env(safe-area-inset-top, 0px) * -1)" }}>
        <header className="min-h-[44px] flex items-center gap-3">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors"><ChevronLeft size={24} /></button>
          <h1 className="text-lg font-bold text-text-primary tracking-tight flex-1">선수</h1>
          <HeaderProfileLink />
        </header>
      </div>

      {/* 검색 */}
      <div className="mt-2 mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            placeholder="선수 이름, 팀, 포지션 검색 (초성 가능)"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setVisibleCount(20);
            }}
            className="w-full rounded-xl bg-bg-secondary py-3 pl-10 pr-4 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>

      {/* 선수기록실 진입 (리그 전체 스탯 정렬) */}
      <Link
        href="/players/records"
        className="mb-3 flex items-center gap-3 rounded-xl bg-accent/10 px-4 py-3 active:bg-accent/20 transition-colors"
      >
        <span className="text-lg">📊</span>
        <div className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-text-primary">선수기록실</span>
          <span className="block text-xs text-text-tertiary">홈런·타율·OPS·ERA 등 기록 순으로 정렬</span>
        </div>
        <ChevronDown className="h-4 w-4 text-text-tertiary -rotate-90 shrink-0" />
      </Link>

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
            onClick={() => { filterTouchedRef.current = true; setFilterTeam(null); setVisibleCount(20); }}
            className={`shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              !filterTeam ? "bg-white/15 text-text-primary" : "bg-bg-secondary/50 text-text-tertiary"
            }`}
          >
            전체
          </button>
          {TEAMS.map((t) => (
            <button
              key={t.id}
              onClick={() => { filterTouchedRef.current = true; setFilterTeam(t.id); setVisibleCount(20); }}
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
            onClick={() => { filterTouchedRef.current = true; setFilterPosition(null); setVisibleCount(20); }}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              !filterPosition ? "bg-white/15 text-text-primary" : "bg-bg-secondary/50 text-text-tertiary"
            }`}
          >
            전체
          </button>
          {POSITIONS.map((pos) => (
            <button
              key={pos}
              onClick={() => { filterTouchedRef.current = true; setFilterPosition(pos); setVisibleCount(20); }}
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
        <span data-testid="players-count" className="text-xs text-text-tertiary">
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
      {sortMode === "popularity" && popularityStatus === "loading" ? (
        // 재정렬 방지: 인기순은 집계가 settle 된 뒤에만 목록을 그린다.
        <div
          data-testid="players-popularity-loading"
          className="py-16 text-center text-sm text-text-tertiary"
        >
          불러오는 중...
        </div>
      ) : (
      <div data-testid="players-list" className="space-y-2 pb-24">
        {filtered.slice(0, visibleCount).map((player, i) => (
          <Link key={player.kboId || i} href={`/community/players/${player.kboId}`} prefetch={false}>
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
                  {duplicateNames.has(player.name) && (
                    <span className="text-xs text-text-tertiary font-medium">
                      {player.team}
                    </span>
                  )}
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
          <div ref={attachLoadMore} data-testid="players-load-more" className="w-full py-4 mt-2 flex justify-center">
            <div className="w-6 h-6 border-2 border-text-tertiary border-t-accent rounded-full animate-spin" />
          </div>
        )}

        {filtered.length === 0 && (
          <div className="text-center py-12 text-text-tertiary text-sm">
            검색 결과가 없습니다
          </div>
        )}
      </div>
      )}
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
