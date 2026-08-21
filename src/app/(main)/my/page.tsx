"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { motion } from "framer-motion";
import Image from "next/image";
import { ChevronLeft, ChevronRight, RefreshCw, Settings, MessageSquareHeart } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamSelectModal from "@/components/onboarding/TeamSelectModal";
import PlayerSelectModal from "@/components/onboarding/PlayerSelectModal";
import { getFavoritePlayers, setFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import { getTeamById } from "@/lib/constants/teams";
import { getMyTeamId, setMyTeamId } from "@/lib/store/myteam";
import { setWidgetMyTeam } from "@/lib/capacitor/game-notification";
import { ID_TO_KBO_CODE } from "@/lib/native-live-activity";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { useAuth } from "@/lib/supabase/AuthContext";
import { updateProfile } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import LoginSheet from "@/components/auth/LoginSheet";
import AvatarSelectSheet from "@/components/profile/AvatarSelectSheet";
import NicknameEditSheet from "@/components/profile/NicknameEditSheet";
import ProfileCard from "@/components/my/ProfileCard";
import InviteSection from "@/components/my/InviteSection";
import FavoritePlayersCard from "@/components/my/FavoritePlayersCard";
import MenuSection from "@/components/my/MenuSection";
import FeedbackSheet from "@/components/feedback/FeedbackSheet";
import VenueDiaryCard from "@/components/my/VenueDiaryCard";
import VenueStatsEntryCard from "@/components/my/VenueStatsEntryCard";

export default function MyPage() {
  const [nicknameStatus, setNicknameStatus] = useState<{
    nickname: string;
    used: number;
    remaining: number;
    limit: number;
    windowDays: number;
    resetAt: string | null;
  } | null>(null);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [showTeamSelect, setShowTeamSelect] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const { user, profile, refreshProfile } = useAuth();
  const [showPlayerSelect, setShowPlayerSelect] = useState(false);
  const [showAvatarSelect, setShowAvatarSelect] = useState(false);
  const [showNicknameEdit, setShowNicknameEdit] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const [writingPoints, setWritingPoints] = useState<number | null>(null);
  const router = useRouter();
  const goBack = useSafeBack("/");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTeamId(getMyTeamId());
    setFavPlayers(getFavoritePlayers());
  }, [profile]);

  useEffect(() => {
    async function loadNicknameStatus() {
      if (!user) {
        setNicknameStatus(null);
        return;
      }

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) return;

      const res = await fetch("/api/me/nickname", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) return;

      const json = await res.json();
      setNicknameStatus(json);
    }

    loadNicknameStatus();
  }, [user, profile?.nickname]);

  useEffect(() => {
    let cancelled = false;
    async function loadWritingPoints() {
      // 유저 변경/로딩 시작 → null(확인 중)로 초기화. 이전 유저 점수 잔존·0 확정 방지.
      setWritingPoints(null);
      if (!user) return;

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return; // 토큰 없음 → null 유지(0 확정 X)

      try {
        const res = await fetch("/api/leaderboard/my-rank?track=writing", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return; // 실패 → null 유지(0 확정 X)

        const json = await res.json();
        if (cancelled) return; // 유저 전환 race 방지
        // 성공 시에만 확정: score 숫자면 그 값, rank null(집계 0건)이면 0pt(루키)
        setWritingPoints(typeof json.score === "number" ? json.score : 0);
      } catch {
        // 네트워크 reject / json parse 실패 → null 유지(0 확정 X), 콘솔 unhandled 방지
      }
    }

    loadWritingPoints();
    return () => { cancelled = true; };
  }, [user]);

  const team = teamId ? getTeamById(teamId) ?? null : null;

  const handleTeamChange = async (newTeamId: number) => {
    setMyTeamId(newTeamId);
    // 위젯/워치 최애팀 즉시 동기화 — 홈 재진입 전에도 네이티브(App Group·WCSession) 반영
    const newTeamCode = ID_TO_KBO_CODE[newTeamId];
    if (newTeamCode) void setWidgetMyTeam(newTeamCode);
    setTeamId(newTeamId);
    setShowTeamSelect(false);
    setFavoritePlayers([]);
    setFavPlayers([]);
    setShowPlayerSelect(true);
    if (user) {
      await updateProfile(user.id, { team_id: newTeamId, favorite_players: [] });
      await refreshProfile();
    }
  };

  const handlePlayerChange = async (players: FavoritePlayer[]) => {
    setFavoritePlayers(players);
    setFavPlayers(players);
    setShowPlayerSelect(false);
    if (user) {
      await updateProfile(user.id, { favorite_players: players });
      await refreshProfile();
    }
  };

  return (
    <div className="mx-auto max-w-lg px-5 pb-24">
      <div className="sticky top-0 z-30 border-b -mx-5 px-5 bg-bg-primary" style={{ borderColor: profile?.team_id ? getTeamBorderColorById(profile.team_id) : 'var(--color-border)', paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <header className="min-h-[44px] flex items-center gap-3">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors"><ChevronLeft size={24} /></button>
          <h1 className="text-lg font-semibold leading-[26px] text-text-primary flex-1">마이페이지</h1>
          <button onClick={() => router.push("/settings")} aria-label="설정" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors -mr-2.5"><Settings size={22} /></button>
        </header>
      </div>

      {/* Profile card — 마이페이지 최상단 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-4">
        <ProfileCard
          user={user}
          profile={profile}
          team={team}
          points={writingPoints}
          onAvatarClick={() => user && setShowAvatarSelect(true)}
          onNicknameClick={() => user && setShowNicknameEdit(true)}
          onViewProfile={() => user && router.push(`/profile/${user.id}`)}
          onHallOfFame={() => user && router.push("/my/hall-of-fame")}
        />
      </motion.div>

      {/* 회원가입 CTA (비로그인) */}
      {!user && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-3">
          <GlassCard className="flex flex-col items-center gap-4 py-6">
            <p className="text-base font-semibold text-text-primary">크보팬에 가입하고 더 많은 기능을 이용하세요</p>
            <p className="text-sm text-text-tertiary">커뮤니티, 쪽지 등 회원 전용 기능</p>
            <button onClick={() => setShowLogin(true)} className="w-full max-w-[240px] rounded-full bg-accent px-8 py-3 text-sm font-semibold text-white transition-transform active:scale-95">
              회원가입 / 로그인
            </button>
          </GlassCard>
        </motion.div>
      )}

      {/* 스토리 지오펜스 인증에서 자동 생성되는 본인 전용 직관 기록.
          2026-08-02 일반 공개(하린아빠 지시) — `AdminOnly` 래퍼를 벗겼다.
          데이터는 이전부터 소유자 인증 API(`/api/me/venue-attendance`)가 본인 것만
          내려주므로, 이 변경은 **표시 게이트만** 열고 서버 인가는 그대로다.
          카드 내부가 비로그인/기록 0건을 자체 처리하므로 별도 가드를 두지 않는다. */}
      <VenueDiaryCard />

      {/* 로그인 사용자 공통 직관 통계 진입점 */}
      <VenueStatsEntryCard />

      {/* 친구 초대 */}
      <InviteSection />

      {/* 응원 구단 변경 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }} className="mt-5">
        <GlassCard pressable className="flex items-center justify-between p-5" onClick={() => setShowTeamSelect(true)}>
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
                <span className="text-sm font-medium text-accent">{team.name}</span>
              </div>
            )}
            <ChevronRight size={22} className="text-text-tertiary" />
          </div>
        </GlassCard>
      </motion.div>

      {/* 최애 선수 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }} className="mt-3">
        <FavoritePlayersCard favPlayers={favPlayers} onEdit={() => setShowPlayerSelect(true)} />
      </motion.div>

      {/* Menu items */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="mt-5">
        <MenuSection />
      </motion.div>

      {/* 피드백 보내기 — 기존 안내(마이페이지 → 피드백 보내기)와 일치하도록 명시 노출 (로그인 유저) */}
      {user && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }} className="mt-3">
          <GlassCard pressable className="flex items-center justify-between p-5" onClick={() => setShowFeedback(true)}>
            <div className="flex items-center gap-4">
              <MessageSquareHeart size={22} className="text-text-secondary" />
              <span className="text-base text-text-primary">피드백 보내기</span>
            </div>
            <ChevronRight size={22} className="text-text-tertiary" />
          </GlassCard>
        </motion.div>
      )}

      {/* Modals */}
      <FeedbackSheet isOpen={showFeedback} onClose={() => setShowFeedback(false)} />
      <TeamSelectModal isOpen={showTeamSelect} onSelect={handleTeamChange} />
      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      <AvatarSelectSheet
        isOpen={showAvatarSelect}
        onClose={() => setShowAvatarSelect(false)}
        currentAvatarUrl={profile?.avatar_url ?? null}
        teamId={teamId}
        nickname={profile?.nickname ?? ""}
      />
      <NicknameEditSheet
        isOpen={showNicknameEdit}
        onClose={() => setShowNicknameEdit(false)}
        currentNickname={profile?.nickname ?? ""}
        status={nicknameStatus}
        onSaved={async () => {
          await refreshProfile();

          const { data } = await supabase.auth.getSession();
          const token = data.session?.access_token;
          if (!token) return;

          const res = await fetch("/api/me/nickname", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return;
          const json = await res.json();
          setNicknameStatus(json);
        }}
      />
      <PlayerSelectModal
        isOpen={showPlayerSelect}
        teamId={teamId ?? 1}
        onComplete={handlePlayerChange}
        onSkip={() => setShowPlayerSelect(false)}
        initialPlayers={favPlayers}
      />
    </div>
  );
}
