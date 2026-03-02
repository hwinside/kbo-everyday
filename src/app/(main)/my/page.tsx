"use client";
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Image from "next/image";
import { Settings, ChevronRight, FileText, MessageCircle, Heart, Trophy, RefreshCw, MapPin, Star, LogIn, LogOut, GraduationCap } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import TeamSelectModal from "@/components/onboarding/TeamSelectModal";
import PlayerSelectModal from "@/components/onboarding/PlayerSelectModal";
import { getFavoritePlayers, setFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getTeamById } from "@/lib/constants/teams";
import { getMyTeamId, setMyTeamId } from "@/lib/store/myteam";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";

export default function MyPage() {
  const [teamId, setTeamId] = useState<number | null>(null);
  const [showTeamSelect, setShowTeamSelect] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const { user, profile, signOut } = useAuth();
  const [showPlayerSelect, setShowPlayerSelect] = useState(false);
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const router = useRouter();

  useEffect(() => {
    setTeamId(getMyTeamId());
    setFavPlayers(getFavoritePlayers());
  }, []);

  const team = teamId ? getTeamById(teamId) : null;

  const handleTeamChange = (newTeamId: number) => {
    setMyTeamId(newTeamId);
    setTeamId(newTeamId);
    setShowTeamSelect(false);
    // 팀 변경 시 최애 선수 재선택
    setFavoritePlayers([]);
    setFavPlayers([]);
    setShowPlayerSelect(true);
  };

  const handlePlayerChange = (players: FavoritePlayer[]) => {
    setFavoritePlayers(players);
    setFavPlayers(players);
    setShowPlayerSelect(false);
  };

  return (
    <div className="mx-auto max-w-lg px-5 pb-24">
      <header className="flex items-center justify-between py-5">
        <h1 className="text-xl font-bold text-text-primary">MY</h1>
        <button className="rounded-full p-2 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <Settings size={24} />
        </button>
      </header>

      {/* Profile card */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <GlassCard className="p-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-bg-tertiary text-2xl">
              ⚾
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold text-text-primary">{user ? (profile?.nickname || user.email || "유저") : "게스트"}</span>
                {team && <TeamBadge teamId={team.id} />}
              </div>
              <LevelBadge level={15} showTitle />
              <p className="mt-0.5 text-base text-text-tertiary">{user ? `${profile?.points || 0} 포인트` : "로그인 해주세요"}</p>
            </div>
          </div>
        </GlassCard>
      </motion.div>

      {/* 응원 구단 변경 */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="mt-5"
      >
        <GlassCard
          pressable
          className="flex items-center justify-between p-5"
          onClick={() => setShowTeamSelect(true)}
        >
          <div className="flex items-center gap-4">
            <RefreshCw size={22} className="text-text-secondary" />
            <span className="text-base text-text-primary">응원 구단 변경</span>
          </div>
          <div className="flex items-center gap-2">
            {team && (
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-white p-0.5 flex items-center justify-center">
                  <Image src={team.logoPath} alt="" width={20} height={20} unoptimized className="object-contain" />
                </div>
                <span className="text-sm font-medium" style={{ color: team.colorLight }}>{team.name}</span>
              </div>
            )}
            <ChevronRight size={22} className="text-text-tertiary" />
          </div>
        </GlassCard>
      </motion.div>

      {/* 최애 선수 */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12 }}
        className="mt-3"
      >
        <GlassCard
          pressable
          className="p-5"
          onClick={() => setShowPlayerSelect(true)}
        >
          <div className="flex items-center gap-4 mb-3">
            <Star size={22} className="text-yellow-400" />
            <span className="text-base text-text-primary">최애 선수</span>
            <ChevronRight size={18} className="ml-auto text-text-tertiary" />
          </div>
          {favPlayers.length > 0 ? (
            <div className="flex gap-3">
              {favPlayers.map(p => (
                <div key={p.playerId} className="flex flex-col items-center gap-1">
                  <PlayerAvatar name={p.name} teamId={p.teamId} photoUrl={getPlayerPhotoUrl(p.name)} number={p.number} size={44} />
                  <span className="text-xs text-text-secondary">{p.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-tertiary">선수를 선택해주세요</p>
          )}
        </GlassCard>
      </motion.div>

      {/* Menu items */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mt-5 space-y-3"
      >
        {[
          { icon: FileText, label: "내가 쓴 글", count: 23 },
          { icon: MessageCircle, label: "내 댓글", count: 89 },
          { icon: Heart, label: "좋아요한 글", count: 156 },
          { icon: Trophy, label: "예측 전적", count: null, detail: "67% 적중" },
          { icon: MapPin, label: "구장 가이드", count: null, detail: "", href: "/stadiums" },
          { icon: GraduationCap, label: "야구 쉽게 배우기", count: null, detail: "NEW", href: "/learn" },
        ].map(({ icon: Icon, label, count, detail, href }: any) => (
          <GlassCard key={label} pressable onClick={() => href && router.push(href)} className="flex items-center justify-between p-5">
            <div className="flex items-center gap-4">
              <Icon size={22} className="text-text-secondary" />
              <span className="text-base text-text-primary">{label}</span>
            </div>
            <div className="flex items-center gap-1 text-text-tertiary">
              {count !== null && <span className="text-base">{count}</span>}
              {detail && <span className="text-base text-accent-gold">{detail}</span>}
              <ChevronRight size={22} />
            </div>
          </GlassCard>
        ))}
      </motion.div>

      {/* Login prompt */}
      {!user && (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-5"
      >
        <GlassCard className="flex flex-col items-center gap-3 py-6">
          <p className="text-sm text-text-tertiary">로그인하면 데이터가 동기화됩니다</p>
          <button onClick={() => setShowLogin(true)} className="rounded-full bg-accent px-8 py-2.5 text-sm font-semibold text-white">
            로그인 / 회원가입
          </button>
        </GlassCard>
      </motion.div>
      )}

      {/* Logged in info */}
      {user && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="mt-5">
          <GlassCard className="flex flex-col items-center gap-3 py-6">
            <p className="text-sm text-green-400">✅ 로그인 완료</p>
            <p className="text-xs text-text-tertiary">{user.email}</p>
            <button onClick={() => signOut()} className="rounded-full bg-bg-tertiary px-8 py-2.5 text-sm font-semibold text-text-secondary">
              로그아웃
            </button>
          </GlassCard>
        </motion.div>
      )}

      {/* Team select modal (reuse onboarding) */}
      <TeamSelectModal
        isOpen={showTeamSelect}
        onSelect={handleTeamChange}
      />
      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      <PlayerSelectModal
        isOpen={showPlayerSelect}
        teamId={teamId ?? 1}
        onComplete={handlePlayerChange}
        onSkip={() => setShowPlayerSelect(false)}
      />
    </div>
  );
}
