"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, FileText, Pencil, X } from "lucide-react";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import LoginSheet from "@/components/auth/LoginSheet";
import PlayerPickerSheet from "@/components/community/PlayerPickerSheet";
import UnifiedFeed from "@/components/community/UnifiedFeed";
import { useAuth } from "@/lib/supabase/AuthContext";
import { createPost, toggleLike } from "@/lib/supabase/usePosts";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import { usePlayerCommunity } from "@/hooks/usePlayerCommunity";
import { getCommunitySourceLabel } from "@/lib/utils/community-board";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

export default function CommunityPlayersPage() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const userTeamId = (profile as Record<string, unknown> | null)?.team_id as number | undefined;

  const {
    favPlayers,
    favLoaded,
    favPlayerIds,
    favPlayerNames,
    loading,
    sortTab,
    selectedPlayer,
    setSelectedPlayer,
    posts,
    handleSortChange,
    loadPosts,
  } = usePlayerCommunity(userTeamId);

  // favIds Set for quick lookup (비최애 판별)
  const favIds = useMemo(() => new Set(favPlayers.map((p) => p.playerId)), [favPlayers]);

  const [writeOpen, setWriteOpen] = useState(false);
  const [writePhotoOpen, setWritePhotoOpen] = useState(false);
  const [writePlayerTarget, setWritePlayerTarget] = useState<string | null>(null);
  const [playerPickerOpen, setPlayerPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"general" | "photo">("general");
  const [showLogin, setShowLogin] = useState(false);
  const [fabExpanded, setFabExpanded] = useState(false);

  const sourceLabels = useMemo(
    () => Object.fromEntries(posts.map((post) => [post.id, getCommunitySourceLabel(post.board_type, post.board_id)])),
    [posts],
  );

  const handleWrite = () => {
    if (!user) { setShowLogin(true); return; }
    setPickerMode("general");
    // 선수가 이미 선택(필터)된 상태면 바로 글쓰기
    if (selectedPlayer && selectedPlayer !== "myTeam") {
      setWritePlayerTarget(selectedPlayer);
      setWriteOpen(true);
    } else {
      // 최애선수 유무 관계없이 선수 선택 시트 열기 (최애선수 상단 + 전체 검색)
      setPlayerPickerOpen(true);
    }
  };

  const handlePhotoWrite = () => {
    if (!user) { setShowLogin(true); return; }
    setPickerMode("photo");
    if (selectedPlayer && selectedPlayer !== "myTeam") {
      setWritePlayerTarget(selectedPlayer);
      setWritePhotoOpen(true);
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

        {/* 최애선수 없어도 글쓰기 FAB + 선수 선택 시트 */}
        <button
          onClick={handleWrite}
          className="fixed bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
        >
          <Pencil size={24} />
        </button>

        <PlayerPickerSheet
          open={playerPickerOpen}
          onClose={() => setPlayerPickerOpen(false)}
          players={favPlayers}
          userTeamId={userTeamId}
          onSelect={(playerId) => {
            setWritePlayerTarget(playerId);
            setPlayerPickerOpen(false);
            if (pickerMode === "photo") setWritePhotoOpen(true);
            else setWriteOpen(true);
          }}
        />

        <WritePost
          isOpen={writeOpen}
          onClose={() => { setWriteOpen(false); setWritePlayerTarget(null); }}
          teamName={writePlayerTarget ? (() => {
            const r = PLAYERS_ROSTER.find((p) => p.kboId === writePlayerTarget);
            const team = r ? TEAMS.find((t) => t.id === r.teamId) : null;
            const label = team ? `${team.shortName} ${r!.name} 선수` : writePlayerTarget + " 선수";
            return label + " 게시판";
          })() : "선수 게시판"}
          onSubmit={async (title, content, imageUrls) => {
            const targetId = writePlayerTarget || "";
            await createPost({ boardType: "player", boardId: targetId, title, content, imageUrls, contentType: "general" });
            setWriteOpen(false);
            setWritePlayerTarget(null);
            if (targetId) router.push(`/community/players/${targetId}`);
          }}
        />

        <WritePhotoPost
          isOpen={writePhotoOpen}
          onClose={() => { setWritePhotoOpen(false); setWritePlayerTarget(null); }}
          teamName={writePlayerTarget ? (() => {
            const r = PLAYERS_ROSTER.find((p) => p.kboId === writePlayerTarget);
            const team = r ? TEAMS.find((t) => t.id === r.teamId) : null;
            return team ? `${team.shortName} ${r!.name} 선수` : writePlayerTarget + " 선수";
          })() : "선수"}
          boardType="player"
          boardId={writePlayerTarget || ""}
          defaultPlayerTag={(() => {
            if (!writePlayerTarget) return undefined;
            const r = PLAYERS_ROSTER.find((p) => p.kboId === writePlayerTarget);
            if (!r) return undefined;
            return { kboId: r.kboId, name: r.name, teamId: r.teamId };
          })()}
          onSuccess={() => {
            const targetId = writePlayerTarget;
            setWritePhotoOpen(false);
            setWritePlayerTarget(null);
            if (targetId) router.push(`/community/players/${targetId}`);
          }}
        />

        {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg">
      {/* Controls */}
      <div className="px-5 pt-3 pb-2 space-y-3">
        {/* Player chip filters */}
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          {/* 내 팀 선수 전체 */}
          {userTeamId && (
            <button
              onClick={() => setSelectedPlayer("myTeam")}
              className={`px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                selectedPlayer === "myTeam" ? "text-white" : "bg-bg-glass text-text-secondary"
              }`}
              style={selectedPlayer === "myTeam" ? { backgroundColor: getTeamById(userTeamId)?.colorPrimary || "#E8364E" } : {}}
            >
              {getTeamById(userTeamId)?.shortName || "내 팀"}선수 전체
            </button>
          )}
          {/* 최애선수 전체 */}
          <button
            onClick={() => setSelectedPlayer(null)}
            className={`px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
              selectedPlayer === null ? "bg-accent text-white" : "bg-bg-glass text-text-secondary"
            }`}
          >
            최애선수 전체
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
              <PlayerAvatar name={player.name} teamId={player.teamId} photoUrl={getPlayerPhotoUrl(player.name, player.playerId)} size={22} />
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

      <div className="py-3">
        <UnifiedFeed
          posts={posts}
          loading={loading}
          onLike={handlePhotoLike}
          boardContext={{ type: "global" }}
          sourceLabels={sourceLabels}
        />
      </div>

      <PlayerPickerSheet
        open={playerPickerOpen}
        onClose={() => setPlayerPickerOpen(false)}
        players={favPlayers}
        userTeamId={userTeamId}
        onSelect={(playerId) => {
          setWritePlayerTarget(playerId);
          setPlayerPickerOpen(false);
          if (pickerMode === "photo") setWritePhotoOpen(true);
          else setWriteOpen(true);
        }}
      />

      <div className="fixed bottom-24 right-5 z-40 flex flex-col-reverse items-center gap-3">
        {fabExpanded && (
          <>
            <button
              onClick={() => { setFabExpanded(false); handleWrite(); }}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-tertiary text-text-primary shadow-lg transition-transform hover:scale-105 active:scale-95"
              aria-label="글쓰기"
            >
              <FileText size={20} />
            </button>
            <button
              onClick={() => { setFabExpanded(false); handlePhotoWrite(); }}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-tertiary text-text-primary shadow-lg transition-transform hover:scale-105 active:scale-95"
              aria-label="사진 올리기"
            >
              <Camera size={20} />
            </button>
          </>
        )}
        <button
          onClick={() => { if (!user) { setShowLogin(true); return; } setFabExpanded(prev => !prev); }}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
          aria-label="작성 메뉴"
        >
          {fabExpanded ? <X size={24} /> : <Pencil size={24} />}
        </button>
      </div>
      {fabExpanded && <div className="fixed inset-0 z-30" onClick={() => setFabExpanded(false)} />}

      <WritePost
        isOpen={writeOpen}
        onClose={() => { setWriteOpen(false); setWritePlayerTarget(null); }}
        teamName={writePlayerTarget ? (() => {
          const r = PLAYERS_ROSTER.find((p) => p.kboId === writePlayerTarget);
          const team = r ? TEAMS.find((t) => t.id === r.teamId) : null;
          const label = team ? `${team.shortName} ${r!.name} 선수` : (favPlayerNames[writePlayerTarget] || writePlayerTarget) + " 선수";
          return label + " 게시판";
        })() : "선수 게시판"}
        onSubmit={async (title, content, imageUrls) => {
          const targetId = writePlayerTarget || favPlayerIds[0];
          await createPost({ boardType: "player", boardId: targetId, title, content, imageUrls, contentType: "general" });
          setWriteOpen(false);
          setWritePlayerTarget(null);
          // 비최애 선수면 해당 선수 게시판으로 이동 (P0: 작성 직후 내 글 확인 보장)
          if (targetId && !favIds.has(targetId)) {
            router.push(`/community/players/${targetId}`);
          } else {
            loadPosts();
          }
        }}
      />

      <WritePhotoPost
        isOpen={writePhotoOpen}
        onClose={() => { setWritePhotoOpen(false); setWritePlayerTarget(null); }}
        teamName={writePlayerTarget ? (() => {
          const r = PLAYERS_ROSTER.find((p) => p.kboId === writePlayerTarget);
          const team = r ? TEAMS.find((t) => t.id === r.teamId) : null;
          return team ? `${team.shortName} ${r!.name} 선수` : (favPlayerNames[writePlayerTarget] || writePlayerTarget) + " 선수";
        })() : "선수"}
        boardType="player"
        boardId={writePlayerTarget || favPlayerIds[0]}
        defaultPlayerTag={(() => {
          if (!writePlayerTarget) return undefined;
          const r = PLAYERS_ROSTER.find((p) => p.kboId === writePlayerTarget);
          if (!r) return undefined;
          return { kboId: r.kboId, name: r.name, teamId: r.teamId };
        })()}
        onSuccess={() => {
          const targetId = writePlayerTarget;
          setWritePhotoOpen(false);
          setWritePlayerTarget(null);
          // 비최애 선수면 해당 선수 게시판으로 이동
          if (targetId && !favIds.has(targetId)) {
            router.push(`/community/players/${targetId}`);
          } else {
            loadPosts();
          }
        }}
      />

      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </div>
  );
}
