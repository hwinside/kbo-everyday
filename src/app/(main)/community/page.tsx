"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ChevronLeft, MessageSquare, Lightbulb } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getMyTeamId } from "@/lib/store/myteam";
import { getFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { useAuth } from "@/lib/supabase/AuthContext";
import FeedbackSheet from "@/components/feedback/FeedbackSheet";
import LoginSheet from "@/components/auth/LoginSheet";

export default function CommunityPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [myTeamId, setMyTeamId] = useState<number | null>(null);
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    setMyTeamId(getMyTeamId());
    setFavPlayers(getFavoritePlayers());
  }, []);

  const myTeam = myTeamId ? getTeamById(myTeamId) : null;

  return (
    <div className="mx-auto max-w-lg pb-24">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3">
        <button
          onClick={() => router.back()}
          className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-3xl font-extrabold tracking-tight text-text-primary">
          커뮤니티
        </h1>
      </div>

      {/* 자유게시판 배너 */}
      <div className="mx-5 mb-6">
        <Link href="/community/free">
          <GlassCard pressable className="border-l-4 border-accent p-5">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10">
                <MessageSquare size={24} className="text-accent" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-text-primary">자유게시판</h3>
                <p className="text-sm text-text-secondary">야구 이야기 자유롭게!</p>
              </div>
            </div>
          </GlassCard>
        </Link>
      </div>

      {/* 내 팀 */}
      {myTeam && (
        <div className="mx-5 mb-6">
          <h2 className="mb-3 text-lg font-bold text-text-primary">내 팀</h2>
          <Link href={`/teams/${myTeam.slug}`}>
            <GlassCard
              pressable
              className="overflow-hidden p-5"
              style={{
                background: `linear-gradient(135deg, ${myTeam.colorPrimary}40 0%, ${myTeam.colorPrimary}10 100%)`,
              }}
            >
              <div className="flex items-center gap-4">
                <TeamBadge teamId={myTeam.id} size="lg" />
                <div className="flex-1">
                  <p className="text-base font-bold text-text-primary">{myTeam.name}</p>
                  <p className="text-sm text-text-secondary">팀 게시판 바로가기 →</p>
                </div>
              </div>
            </GlassCard>
          </Link>
        </div>
      )}

      {/* 전체 구단 */}
      <div className="mx-5 mb-6">
        <h2 className="mb-3 text-lg font-bold text-text-primary">전체 구단</h2>
        <div className="grid grid-cols-5 gap-3">
          {TEAMS.map((team) => (
            <Link key={team.id} href={`/teams/${team.slug}`}>
              <div className="flex flex-col items-center gap-1.5 rounded-xl py-3 transition-colors hover:bg-bg-secondary">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white p-1">
                  <Image
                    src={team.logoPath}
                    alt={team.name}
                    width={28}
                    height={28}
                    unoptimized
                    className="object-contain"
                  />
                </div>
                <span
                  className="text-xs font-semibold"
                  style={{ color: team.colorLight }}
                >
                  {team.shortName}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* 최애 선수 게시판 */}
      <div className="mx-5 mb-6">
        <h2 className="mb-3 text-lg font-bold text-text-primary">최애 선수 게시판</h2>
        {favPlayers.length > 0 ? (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            {favPlayers.map((player) => (
              <Link key={player.playerId} href={`/boards/players/${player.playerId}`}>
                <GlassCard pressable className="flex flex-col items-center gap-2 p-4">
                  <PlayerAvatar
                    name={player.name}
                    teamId={player.teamId}
                    photoUrl={getPlayerPhotoUrl(player.name)}
                    size={48}
                  />
                  <span className="text-sm font-semibold text-text-primary text-center">
                    {player.name}
                  </span>
                </GlassCard>
              </Link>
            ))}
          </div>
        ) : (
          <GlassCard className="p-5">
            <p className="text-center text-sm text-text-tertiary">
              최애 선수를 설정하면 여기에 표시됩니다
            </p>
          </GlassCard>
        )}
      </div>

      {/* 💡 건의함 배너 */}
      <div className="mx-5 mb-6">
        <GlassCard
          pressable
          className="border-l-4 border-yellow-400 p-5"
          onClick={() => {
            if (user) {
              setShowFeedback(true);
            } else {
              setShowLogin(true);
            }
          }}
        >
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-yellow-400/10">
              <Lightbulb size={24} className="text-yellow-400" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-text-primary">💡 건의함</h3>
              <p className="text-sm text-text-secondary">버그 신고, 기능 제안, 데이터 수정 요청</p>
            </div>
          </div>
        </GlassCard>
      </div>

      <FeedbackSheet isOpen={showFeedback} onClose={() => setShowFeedback(false)} defaultType="feature" />
      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
