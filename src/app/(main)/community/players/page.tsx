"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import LoginSheet from "@/components/auth/LoginSheet";
import PlayerPickerSheet from "@/components/community/PlayerPickerSheet";
import PlayerPostContent from "@/components/community/PlayerPostContent";
import { useAuth } from "@/lib/supabase/AuthContext";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { TEAMS } from "@/lib/constants/teams";
import { usePlayerCommunity } from "@/hooks/usePlayerCommunity";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

export default function CommunityPlayersPage() {
  const router = useRouter();
  const { user } = useAuth();

  const {
    favPlayers,
    favLoaded,
    favPlayerIds,
    favPlayerNames,
    loading,
    photoLoading,
    contentTab,
    sortTab,
    selectedPlayer,
    setSelectedPlayer,
    filteredPosts,
    filteredPhotoPosts,
    handleTabChange,
    handleSortChange,
    loadPosts,
    loadPhotoPosts,
  } = usePlayerCommunity();

  const [writeOpen, setWriteOpen] = useState(false);
  const [writePhotoOpen, setWritePhotoOpen] = useState(false);
  const [writePlayerTarget, setWritePlayerTarget] = useState<string | null>(null);
  const [playerPickerOpen, setPlayerPickerOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const handleWrite = () => {
    if (!user) { setShowLogin(true); return; }
    if (favPlayerIds.length === 0) { router.push("/my"); return; }
    if (favPlayerIds.length === 1 || selectedPlayer) {
      setWritePlayerTarget(selectedPlayer || favPlayerIds[0]);
      if (contentTab === "photo") setWritePhotoOpen(true);
      else setWriteOpen(true);
    } else {
      setPlayerPickerOpen(true);
    }
  };

  const getPlayerTeamColor = (playerId: string) => {
    const fav = favPlayers.find((p) => p.playerId === playerId);
    if (!fav) return "#E8364E";
    return TEAMS.find((t) => t.id === fav.teamId)?.colorPrimary || "#E8364E";
  };

  const handlePhotoLike = async (postId: number) => {
    try { await toggleLike(postId); } catch { /* ignore */ }
  };

  if (!favLoaded) {
    return (
      <div className="mx-auto max-w-lg px-5 pb-24">
        <div className="mt-8 space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="glass-card p-5 animate-pulse">
              <div className="h-4 bg-bg-tertiary rounded w-24 mb-3" />
              <div className="h-5 bg-bg-tertiary rounded w-3/4 mb-2" />
              <div className="h-4 bg-bg-tertiary rounded w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (favPlayerIds.length === 0) {
    return (
      <div className="mx-auto max-w-lg px-5 pb-24">
        <div className="flex flex-col items-center justify-center py-28 text-center">
          <div className="text-5xl mb-4">⚾</div>
          <p className="text-lg font-bold text-text-primary mb-2">
            최애선수를 선택하면<br />선수 게시판이 열려요
          </p>
          <p className="text-sm text-text-tertiary mb-6">
            최대 5명의 최애선수를 등록하고<br />관련 글을 한 곳에서 모아보세요
          </p>
          <Link
            href="/my"
            className="inline-flex items-center gap-1.5 px-6 py-3 rounded-xl text-sm font-semibold text-white bg-accent transition-colors hover:bg-accent/90"
          >
            선수 선택하기
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg">
      {/* Controls */}
      <div className="px-5 pb-2 space-y-3">
        <div className="flex items-center justify-between pt-3">
          <div className="flex bg-bg-glass rounded-xl p-1">
            {(["general", "photo"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => handleTabChange(tab)}
                className={`relative px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
                  contentTab === tab
                    ? "bg-text-primary text-bg-primary shadow-sm"
                    : "text-text-tertiary hover:text-text-secondary"
                }`}
              >
                {tab === "general" ? "일반" : "사진"}
              </button>
            ))}
          </div>
        </div>

        {/* Player chip filters */}
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          <button
            onClick={() => setSelectedPlayer(null)}
            className={`px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
              selectedPlayer === null ? "bg-accent text-white" : "bg-bg-glass text-text-secondary"
            }`}
          >
            전체
          </button>
          {favPlayers.map((player) => (
            <button
              key={player.playerId}
              onClick={() => setSelectedPlayer(player.playerId)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                selectedPlayer === player.playerId ? "text-white" : "bg-bg-glass text-text-secondary"
              }`}
              style={selectedPlayer === player.playerId ? { backgroundColor: getPlayerTeamColor(player.playerId) } : {}}
            >
              <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={getPlayerPhotoUrl(player.name)} size={22} />
              {player.name}
            </button>
          ))}
        </div>

        {/* Sort toggle */}
        <div className="flex gap-2">
          {(["latest", "hot"] as const).map((sort) => (
            <button
              key={sort}
              onClick={() => handleSortChange(sort)}
              className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
                sortTab === sort ? "bg-bg-tertiary text-text-primary" : "text-text-tertiary hover:text-text-secondary"
              }`}
            >
              {sort === "latest" ? "최신" : "인기"}
            </button>
          ))}
          {sortTab === "hot" && <span className="flex items-center text-xs text-text-tertiary ml-1">최근 7일</span>}
        </div>
      </div>

      <PlayerPostContent
        contentTab={contentTab}
        loading={loading}
        photoLoading={photoLoading}
        filteredPosts={filteredPosts}
        filteredPhotoPosts={filteredPhotoPosts}
        favPlayers={favPlayers}
        onPhotoLike={handlePhotoLike}
      />

      <PlayerPickerSheet
        open={playerPickerOpen}
        onClose={() => setPlayerPickerOpen(false)}
        players={favPlayers}
        onSelect={(playerId) => {
          setWritePlayerTarget(playerId);
          setPlayerPickerOpen(false);
          if (contentTab === "photo") setWritePhotoOpen(true);
          else setWriteOpen(true);
        }}
      />

      <button
        onClick={handleWrite}
        className="fixed bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
      >
        <Pencil size={24} />
      </button>

      <WritePost
        isOpen={writeOpen}
        onClose={() => { setWriteOpen(false); setWritePlayerTarget(null); }}
        teamName={writePlayerTarget ? (favPlayerNames[writePlayerTarget] || writePlayerTarget) + " 게시판" : "선수 게시판"}
        onSubmit={async (title, content, imageUrls) => {
          await createPost({ boardType: "player", boardId: writePlayerTarget || favPlayerIds[0], title, content, imageUrls, contentType: "general" });
          setWriteOpen(false);
          setWritePlayerTarget(null);
          loadPosts();
        }}
      />

      <WritePhotoPost
        isOpen={writePhotoOpen}
        onClose={() => { setWritePhotoOpen(false); setWritePlayerTarget(null); }}
        teamName={writePlayerTarget ? (favPlayerNames[writePlayerTarget] || writePlayerTarget) : "선수"}
        boardType="player"
        boardId={writePlayerTarget || favPlayerIds[0]}
        defaultPlayerTag={(() => {
          if (!writePlayerTarget) return undefined;
          const r = PLAYERS_ROSTER.find((p) => p.kboId === writePlayerTarget);
          if (!r) return undefined;
          return { id: Number(r.kboId), name: r.name, teamId: r.teamId };
        })()}
        onSuccess={() => { setWritePhotoOpen(false); setWritePlayerTarget(null); loadPhotoPosts(); }}
      />

      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
