"use client";

import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";

import { useState, useMemo, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Check, Search, X, Plus } from "lucide-react";
import Image from "next/image";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getTeamById, TEAMS } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";
import type { FavoritePlayer } from "@/lib/store/favorites";
import playersRoster from "@/lib/constants/players-roster.json";
import { matchHangul } from "@/lib/utils/hangul-search";
import {
  normalizePopularityCounts,
  sortPlayersByPopularity,
  type PopularityCounts,
} from "@/lib/utils/player-popularity";

interface PlayerInfo {
  id: string;
  name: string;
  team: string;
  teamId: number;
  position?: string;
  backNo?: string;
}

interface PlayerSelectModalProps {
  isOpen: boolean;
  teamId: number;
  onComplete: (players: FavoritePlayer[]) => void;
  onSkip: () => void;
  initialPlayers?: FavoritePlayer[];
}

// 팀 약칭 → teamId 매핑
const TEAM_SHORT_MAP: Record<string, number> = {
  LG: 1, "두산": 2, KT: 3, SSG: 4, NC: 5, KIA: 6, "롯데": 7, "삼성": 8, "한화": 9, "키움": 10,
};

export default function PlayerSelectModal({ isOpen, teamId, onComplete, onSkip, initialPlayers = [] }: PlayerSelectModalProps) {
  const { user } = useAuth();
  const maxPlayers = user ? 5 : 2;
  const [showLogin, setShowLogin] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 모달 열릴 때 기존 선택 복원 (빈 배열이면 초기화)
  // initialPlayers를 dep에 직접 넣으면 default `[]` 또는 부모 리렌더가 ref를 흔들어
  // toggle 직후 effect 재실행 → setSelected 초기화로 선택이 안 남는 회귀 발생.
  // 따라서 ref로 캡처해 isOpen false→true 트랜지션 시점에만 한 번 적용.
  const initialPlayersRef = useRef(initialPlayers);
  useEffect(() => { initialPlayersRef.current = initialPlayers; });
  useEffect(() => {
    if (isOpen) {
      setSelected(new Set(initialPlayersRef.current.map(p => p.playerId)));
    }
  }, [isOpen]);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const team = getTeamById(teamId);

  // 선수별 "최애선수로 지정한 계정 수" — 목록을 인기순으로 정렬하는 데 쓴다.
  // 집계는 서버 route(DB RPC)가 하고 여기서는 결과만 받는다.
  // 최초 목록은 응답 또는 bounded timeout 뒤 한 번만 표시한다. 늦은 응답으로 이미
  // 터치·스크롤 중인 행이 재정렬되지 않으며, 실패/timeout은 가나다순으로 폴백한다.
  const [popularity, setPopularity] = useState<PopularityCounts>({});
  const [popularityStatus, setPopularityStatus] = useState<"loading" | "ready">("loading");
  useEffect(() => {
    if (!isOpen) {
      // 닫힌 동안 다음 open을 loading 상태로 준비해, 재오픈 첫 paint에도 이전 순위가
      // 잠깐 노출됐다가 이동하는 프레임이 생기지 않게 한다.
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setPopularity({});
        setPopularityStatus("loading");
      });
      return () => { cancelled = true; };
    }
    let stale = false;
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (stale || settled) return;
      settled = true;
      setPopularityStatus("ready");
    }, 1200);
    (async () => {
      try {
        const res = await fetch("/api/player-popularity");
        const json = res.ok ? await res.json() : null;
        if (stale || settled) return;
        settled = true;
        setPopularity(normalizePopularityCounts(json?.counts));
        setPopularityStatus("ready");
      } catch {
        if (stale || settled) return;
        settled = true;
        setPopularityStatus("ready");
      }
    })();
    return () => {
      stale = true;
      window.clearTimeout(timeout);
    };
  }, [isOpen]);

  const allPlayers = useMemo<PlayerInfo[]>(() => {
    const roster = playersRoster as { kboId: string; name: string; team: string; teamId: number; position: string; backNo: string }[];
    const seen = new Set<string>();
    const result: PlayerInfo[] = [];

    for (const p of roster) {
      // kboId 우선, 없으면 teamId:name:position:backNo 복합키
      const key = p.kboId
        ? p.kboId
        : `${p.teamId}:${p.name}:${p.position || ""}:${p.backNo || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: p.kboId,
        name: p.name,
        team: p.team,
        teamId: p.teamId,
        position: p.position,
        backNo: p.backNo,
      });
    }

    return result;
  }, []);

  // 선택 순서 보존: Set은 insertion order를 유지하므로 Set 순회로 배열 생성
  const selectedPlayersArr = [...selected]
    .map(id => allPlayers.find(p => p.id === id))
    .filter((p): p is PlayerInfo => !!p);
  const myTeamPlayers = useMemo(
    () => sortPlayersByPopularity(allPlayers.filter(p => p.teamId === teamId), popularity),
    [allPlayers, teamId, popularity],
  );
  const otherPlayers = allPlayers.filter(p => p.teamId !== teamId);
  const [visibleCount, setVisibleCount] = useState(30);
  // 팀 탭·전체 탭·검색 결과 모두 같은 기준(지정 계정 수 ↓, 동률 가나다순)으로 정렬한다.
  const allDisplayPlayers = useMemo(() => {
    if (search) {
      return sortPlayersByPopularity(
        allPlayers.filter(p => matchHangul(p.name, search)),
        popularity,
      );
    }
    return showAll ? sortPlayersByPopularity(allPlayers, popularity) : myTeamPlayers;
  }, [search, showAll, allPlayers, myTeamPlayers, popularity]);
  const displayPlayers = allDisplayPlayers.slice(0, visibleCount);

  // 무한스크롤 onScroll (iOS Safari IntersectionObserver 불안정 대응)
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // 하단 200px 이내 도달 시 다음 배치 로드
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      setVisibleCount(v => {
        const total = allDisplayPlayers.length;
        return v < total ? Math.min(v + 30, total) : v;
      });
    }
  };

  const toggle = (player: PlayerInfo) => {
    // 선수가 새로 추가되는 경우(제거/한도초과 아님)에만 검색어 초기화
    const willAdd = !selected.has(player.id) && selected.size < maxPlayers;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(player.id)) next.delete(player.id);
      else if (next.size < maxPlayers) next.add(player.id);
      else if (!user) { setShowLogin(true); return prev; }
      return next;
    });
    // 검색 후 선택하면 검색창을 비워 바로 다음 선수를 검색할 수 있게 함
    if (willAdd && search) {
      setSearch("");
      setVisibleCount(30);
    }
  };

  // 브라우저 뒤로가기 시 about:blank 방지: history 엔트리 push + popstate로 모달 닫기
  const closingRef = useRef(false);
  const didPopRef = useRef(false);
  const onSkipRef = useRef(onSkip);
  useEffect(() => { onSkipRef.current = onSkip; }, [onSkip]);

  useEffect(() => {
    if (!isOpen) return;
    closingRef.current = false;
    didPopRef.current = false;
    history.pushState({ playerSelectModal: true }, "");
    const handlePopState = () => {
      if (closingRef.current) return;
      didPopRef.current = true;
      onSkipRef.current();
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (!closingRef.current && !didPopRef.current) history.back();
    };
  }, [isOpen]);

  const handleComplete = () => {
    closingRef.current = true;
    history.back();
    // 저장 순서 = 화면 슬롯 순서(선택 순서). allPlayers.filter는 로스터 원본 순서로
    // 뒤바뀌어 DB에 저장돼, 재조회 시 사용자가 지정한 순서가 사라지는 회귀가 있었음.
    const favs: FavoritePlayer[] = selectedPlayersArr
      .map(p => ({
        playerId: p.id,
        name: p.name,
        teamId: p.teamId,
        position: p.position || "",
        number: p.backNo ? parseInt(p.backNo, 10) || 0 : 0,
      }));
    onComplete(favs);
  };

  if (!isOpen || !team) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] overflow-y-auto bg-bg-primary"
    >
      {/* 콘텐츠가 화면보다 길면 전체가 스크롤되도록(중앙정렬 고정 시 상/하단이 잘려
          맨 아래 "나중에 할게요"가 네비바 뒤로 밀려 닿지 않던 문제). 하단은 safe-area +
          여유 패딩으로 시스템 네비바 위로 띄운다. 상단도 safe-area 기준 — 엣지투엣지
          기기에서 고정 pt-10이면 타이틀이 상태바/온보딩 진행 바(z-110)와 겹친다. */}
      <div className="w-full max-w-lg mx-auto px-6 pt-[calc(env(safe-area-inset-top,0px)+44px)] pb-[calc(env(safe-area-inset-bottom,0px)+24px)]">
        <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.1 }} className="text-center mb-4">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Image src={team.logoPath} alt="" width={32} height={32} unoptimized className="object-contain" />
            <h1 className="text-xl font-bold text-text-primary">최애 선수를 골라주세요</h1>
          </div>
            {!user && <p className="text-xs text-accent mt-1">로그인하면 5명까지 선택 가능!</p>}
          <p className="text-sm text-text-tertiary">최대 {maxPlayers}명 · 선택한 선수 중심으로 피드가 구성됩니다</p>

          {/* 선택된 선수 슬롯 */}
          <div className="flex justify-center gap-2.5 mt-3">
            {Array.from({ length: maxPlayers }, (_, i) => {
              const player = selectedPlayersArr[i];
              return (
                <div key={i} className="flex flex-col items-center w-14">
                  {player ? (
                    <button
                      onClick={() => toggle(player)}
                      className="relative group"
                    >
                      <PlayerAvatar
                        name={player.name}
                        teamId={player.teamId}
                        photoUrl={getPlayerPhotoUrl(player.name, player.id)}
                        number={0}
                        size={44}
                      />
                      <div
                        className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center"
                        style={{ backgroundColor: team.colorLight }}
                      >
                        <X size={12} className="text-white" />
                      </div>
                      <p className="text-[11px] font-medium text-text-primary mt-1 truncate w-full text-center">
                        {player.name}
                      </p>
                    </button>
                  ) : (
                    <div className="flex flex-col items-center">
                      <div className="w-11 h-11 rounded-full border-2 border-dashed border-text-tertiary/30 flex items-center justify-center">
                        <Plus size={16} className="text-text-tertiary/40" />
                      </div>
                      <p className="text-[11px] text-text-tertiary/40 mt-1">&nbsp;</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </motion.div>

        {/* 검색 */}
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="선수 검색 (초성 가능)"
            className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
          />
        </div>

        {/* 탭 */}
        {!search && (
          <div className="flex gap-2 mb-3">
            <button onClick={() => { setShowAll(false); setVisibleCount(30); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${!showAll ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"}`}>
              {team.shortName} 선수 ({myTeamPlayers.length})
            </button>
            <button onClick={() => { setShowAll(true); setVisibleCount(30); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${showAll ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"}`}>
              전체 선수 ({allPlayers.length})
            </button>
          </div>
        )}

        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="space-y-2 max-h-[45vh] overflow-y-auto overscroll-contain">
          {popularityStatus === "loading" ? (
            <div data-testid="player-popularity-loading" className="text-center py-8 text-text-tertiary text-sm">
              인기순을 불러오는 중...
            </div>
          ) : displayPlayers.length === 0 ? (
            <div className="text-center py-8 text-text-tertiary text-sm">검색 결과가 없습니다</div>
          ) : displayPlayers.map((player) => {
            const isSelected = selected.has(player.id);
            return (
              <button key={player.id} onClick={() => toggle(player)}
                className="w-full flex items-center gap-3 p-3 rounded-2xl transition-all"
                style={{
                  background: isSelected ? `${team.colorPrimary}20` : "rgba(255,255,255,0.03)",
                  border: `2px solid ${isSelected ? team.colorLight : "transparent"}`,
                }}>
                <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={getPlayerPhotoUrl(player.name, player.id)} number={0} size={48} showTeamBadge={true} />
                <div className="flex-1 text-left">
                  <p className="text-sm font-bold text-text-primary">{player.name}</p>
                  {<TeamBadge teamId={player.teamId} size="xs" />}
                </div>
                {isSelected ? (
                  <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ backgroundColor: team.colorLight }}>
                    <Check size={16} className="text-white" />
                  </div>
                ) : (
                  <div className="w-7 h-7 rounded-full border-2 border-text-tertiary/30" />
                )}
              </button>
            );
          })}
          {visibleCount < allDisplayPlayers.length && (
            <div className="w-full py-3 text-center text-xs text-text-tertiary">
              로딩 중...
            </div>
          )}
        </div>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="mt-5 space-y-2">
          <button onClick={handleComplete} disabled={selected.size === 0}
            className="w-full py-3 rounded-xl text-sm font-bold text-white transition-opacity disabled:opacity-30"
            style={{ backgroundColor: team.colorLight }}>
            {selected.size}명 선택 완료
          </button>
          <button onClick={() => history.back()} className="w-full py-2 text-sm text-text-tertiary">나중에 할게요</button>
        </motion.div>
      </div>
    </motion.div>
  );
}
