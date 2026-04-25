"use client";

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search } from "lucide-react";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getTeamById, TEAMS } from "@/lib/constants/teams";
import type { FavoritePlayer } from "@/lib/store/favorites";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { matchHangul } from "@/lib/utils/hangul-search";

interface PlayerPickerSheetProps {
  open: boolean;
  onClose: () => void;
  players: FavoritePlayer[];
  onSelect: (playerId: string) => void;
  /** User's team id for prioritising roster list */
  userTeamId?: number;
}

export default function PlayerPickerSheet({ open, onClose, players: favPlayers, onSelect, userTeamId }: PlayerPickerSheetProps) {
  const [search, setSearch] = useState("");

  const favIds = useMemo(() => new Set(favPlayers.map((p) => p.playerId)), [favPlayers]);

  // Enrich favorites with roster info (position/backNo)
  const rosterMap = useMemo(() => {
    const m = new Map<string, { position: string; backNo: string }>();
    for (const p of PLAYERS_ROSTER) m.set(p.kboId, { position: p.position || "", backNo: p.backNo || "" });
    return m;
  }, []);

  // All roster players grouped: favorites first, then user's team, then rest
  const allPlayers = useMemo(() => {
    const roster = PLAYERS_ROSTER.map((p) => ({
      playerId: p.kboId,
      name: p.name,
      teamId: p.teamId,
      position: p.position || "",
      backNo: p.backNo || "",
    }));

    // Dedupe by kboId
    const seen = new Set<string>();
    return roster.filter((p) => {
      if (seen.has(p.playerId)) return false;
      seen.add(p.playerId);
      return true;
    });
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.trim();
    return allPlayers
      .filter((p) => !favIds.has(p.playerId))
      .filter((p) => {
        const team = getTeamById(p.teamId);
        return (
          matchHangul(p.name, q) ||
          (team?.shortName && matchHangul(team.shortName, q)) ||
          (team?.name && matchHangul(team.name, q)) ||
          p.backNo.includes(q)
        );
      })
      .slice(0, 30);
  }, [search, allPlayers, favIds]);

  // When no search: show user's team players (excluding favorites)
  const myTeamPlayers = useMemo(() => {
    if (search.trim()) return [];
    if (!userTeamId) return [];
    return allPlayers
      .filter((p) => p.teamId === userTeamId && !favIds.has(p.playerId))
      .slice(0, 30);
  }, [allPlayers, userTeamId, favIds, search]);

  function handleSelect(playerId: string) {
    setSearch("");
    onSelect(playerId);
  }

  function handleClose() {
    setSearch("");
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60"
            onClick={handleClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-bg-secondary overflow-hidden flex flex-col"
            style={{ maxHeight: "92dvh" }}
          >
            {/* Swipe-down handle */}
            <motion.div
              className="flex justify-center pt-3 cursor-grab active:cursor-grabbing"
              drag="y"
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.8 }}
              onDragEnd={(_e, info) => {
                if (info.offset.y > 80 || info.velocity.y > 300) handleClose();
              }}
            >
              <div className="h-1 w-10 rounded-full bg-text-tertiary" />
            </motion.div>

            <div className="sticky top-0 bg-bg-secondary px-5 pt-3 pb-2 z-10 space-y-3">
              <h3 className="text-lg font-bold text-text-primary">어떤 선수 게시판에 쓸까요?</h3>
              {/* Search */}
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input
                  type="text"
                  placeholder="선수 검색 (초성 가능)"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                />
              </div>
            </div>

            <div className="px-5 pb-24 overflow-y-auto flex-1">
              {/* Favorites section */}
              {favPlayers.length > 0 && !search.trim() && (
                <div className="mb-4">
                  <p className="text-xs font-medium text-text-tertiary mb-2 px-1">⭐ 내 최애선수</p>
                  <div className="space-y-1.5">
                    {favPlayers.map((player) => {
                      const ri = rosterMap.get(player.playerId);
                      return (
                        <PlayerRow
                          key={player.playerId}
                          playerId={player.playerId}
                          name={player.name}
                          teamId={player.teamId}
                          position={ri?.position}
                          backNo={ri?.backNo}
                          onSelect={handleSelect}
                          highlight
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Search results */}
              {search.trim() && (
                <div>
                  {/* Also show matching favorites */}
                  {favPlayers
                    .filter((p) => matchHangul(p.name, search.trim()))
                    .map((player) => {
                      const ri = rosterMap.get(player.playerId);
                      return (
                        <PlayerRow
                          key={player.playerId}
                          playerId={player.playerId}
                          name={player.name}
                          teamId={player.teamId}
                          position={ri?.position}
                          backNo={ri?.backNo}
                          onSelect={handleSelect}
                          highlight
                        />
                      );
                    })}
                  {filtered.length === 0 && favPlayers.filter((p) => matchHangul(p.name, search.trim())).length === 0 && (
                    <p className="text-sm text-text-tertiary text-center py-8">검색 결과가 없습니다</p>
                  )}
                  <div className="space-y-1.5">
                    {filtered.map((player) => (
                      <PlayerRow
                        key={player.playerId}
                        playerId={player.playerId}
                        name={player.name}
                        teamId={player.teamId}
                        position={player.position}
                        backNo={player.backNo}
                        onSelect={handleSelect}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* My team section (no search) */}
              {!search.trim() && myTeamPlayers.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-medium text-text-tertiary mb-2 px-1">
                    {getTeamById(userTeamId!)?.shortName ?? "내 팀"} 선수
                  </p>
                  <div className="space-y-1.5">
                    {myTeamPlayers.map((player) => (
                      <PlayerRow
                        key={player.playerId}
                        playerId={player.playerId}
                        name={player.name}
                        teamId={player.teamId}
                        position={player.position}
                        backNo={player.backNo}
                        onSelect={handleSelect}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Prompt to search */}
              {!search.trim() && (
                <p className="text-xs text-text-tertiary text-center py-4">
                  다른 선수는 이름이나 초성으로 검색해보세요 🔍
                </p>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function PlayerRow({
  playerId,
  name,
  teamId,
  position,
  backNo,
  onSelect,
  highlight,
}: {
  playerId: string;
  name: string;
  teamId: number;
  position?: string;
  backNo?: string;
  onSelect: (id: string) => void;
  highlight?: boolean;
}) {
  const team = getTeamById(teamId);
  const sub = [team?.shortName, position, backNo ? `#${backNo}` : ""].filter(Boolean).join(" · ");
  return (
    <button
      onClick={() => onSelect(playerId)}
      className={`w-full flex items-center gap-3 text-left rounded-xl px-4 py-3 text-sm font-semibold text-text-primary hover:bg-bg-glass active:scale-[0.98] transition-all ${
        highlight ? "bg-bg-tertiary" : "bg-bg-tertiary/50"
      }`}
    >
      <PlayerAvatar
        name={name}
        teamId={teamId}
        photoUrl={getPlayerPhotoUrl(name, playerId)}
        size={36}
      />
      <div className="flex-1 min-w-0">
        <span className="block">{name}</span>
        {sub && <span className="block text-xs font-normal text-text-tertiary truncate">{sub}</span>}
      </div>
    </button>
  );
}
