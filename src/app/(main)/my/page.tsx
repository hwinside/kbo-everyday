"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Download, RefreshCw, MessageSquareHeart } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamSelectModal from "@/components/onboarding/TeamSelectModal";
import PlayerSelectModal from "@/components/onboarding/PlayerSelectModal";
import { getFavoritePlayers, setFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import { getTeamById } from "@/lib/constants/teams";
import { getMyTeamId, setMyTeamId } from "@/lib/store/myteam";
import { isNative } from "@/lib/capacitor/platform";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import { usePushNotification } from "@/lib/hooks/usePushNotification";
import { useAuth } from "@/lib/supabase/AuthContext";
import { updateProfile } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import LoginSheet from "@/components/auth/LoginSheet";
import FeedbackSheet from "@/components/feedback/FeedbackSheet";
import AvatarSelectSheet from "@/components/profile/AvatarSelectSheet";
import NicknameEditSheet from "@/components/profile/NicknameEditSheet";
import ProfileCard from "@/components/my/ProfileCard";
import InviteSection from "@/components/my/InviteSection";
import EventResultCard from "@/components/my/EventResultCard";
import FavoritePlayersCard from "@/components/my/FavoritePlayersCard";
import NotificationCard from "@/components/my/NotificationCard";
import NotificationPrefsCard from "@/components/my/NotificationPrefsCard";
import MenuSection from "@/components/my/MenuSection";
import ThemeToggleCard from "@/components/my/ThemeToggleCard";
import ShortsToggleCard from "@/components/my/ShortsToggleCard";
import PwaGuideModal from "@/components/my/PwaGuideModal";
import DeleteAccountSheet from "@/components/my/DeleteAccountSheet";

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
  const { user, profile, signOut, refreshProfile } = useAuth();
  const { permission, subscription, subscribe, unsubscribe } = usePushNotification();
  const [showPlayerSelect, setShowPlayerSelect] = useState(false);
  const [showPwaGuide, setShowPwaGuide] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showAvatarSelect, setShowAvatarSelect] = useState(false);
  const [showNicknameEdit, setShowNicknameEdit] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [favPlayers, setFavPlayers] = useState<FavoritePlayer[]>([]);
  const [writingPoints, setWritingPoints] = useState<number | null>(null);
  const router = useRouter();

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
      <div className="border-b -mx-5 px-5" style={{ borderColor: profile?.team_id ? getTeamBorderColorById(profile.team_id) : 'var(--color-border)' }}>
        <header className="py-3 flex items-center gap-3">
          <button onClick={() => router.back()} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors"><ChevronLeft size={24} /></button>
          <h1 className="text-lg font-semibold leading-[26px] text-text-primary flex-1">마이페이지</h1>
        </header>
      </div>

      {/* 회원가입 CTA (비로그인 시 최상단) */}
      {!user && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
          <GlassCard className="flex flex-col items-center gap-4 py-6">
            <p className="text-base font-semibold text-text-primary">크보팬에 가입하고 더 많은 기능을 이용하세요</p>
            <p className="text-sm text-text-tertiary">승부예측, 커뮤니티, 쪽지 등 회원 전용 기능</p>
            <button onClick={() => setShowLogin(true)} className="w-full max-w-[240px] rounded-full bg-accent px-8 py-3 text-sm font-semibold text-white transition-transform active:scale-95">
              회원가입 / 로그인
            </button>
          </GlassCard>
        </motion.div>
      )}

      {/* Profile card */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className={user ? "mt-6" : "mt-3"}>
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

      {/* 친구 초대 */}
      <InviteSection />

      {/* 얼리멤버 이벤트 최종 결과 (스냅샷 기준 — 공지 CTA /my#event-result 앵커 타깃) */}
      {user && (
        <motion.div id="event-result" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }} className="mt-5 scroll-mt-20">
          <EventResultCard />
        </motion.div>
      )}

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

      {/* 앱 설치 — 네이티브 앱에선 불필요 */}
      {typeof window !== "undefined" && !isNative && !window.matchMedia("(display-mode: standalone)").matches && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mt-3">
          <GlassCard
            pressable
            className="flex items-center justify-between p-5"
            onClick={() => {
              const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
              if (ios) {
                alert("Safari 하단의 공유 버튼 → 홈 화면에 추가를 선택하세요!");
              } else {
                const evt = (window as unknown as { __pwaPrompt?: { prompt: () => void } }).__pwaPrompt;
                if (evt) { evt.prompt(); } else { alert("브라우저 메뉴에서 '홈 화면에 추가'를 선택하세요!"); }
              }
            }}
          >
            <div className="flex items-center gap-4">
              <Download size={22} className="text-text-secondary" />
              <span className="text-base text-text-primary">앱 설치하기</span>
            </div>
            <ChevronRight size={22} className="text-text-tertiary" />
          </GlassCard>
        </motion.div>
      )}

      {/* 최애 선수 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }} className="mt-3">
        <FavoritePlayersCard favPlayers={favPlayers} onEdit={() => setShowPlayerSelect(true)} />
      </motion.div>

      {/* 알림 설정 — 실제 알림 트리거(경기시작·득점) 구현+QA 완료 전까지 숨김. NEXT_PUBLIC_ENABLE_PUSH=true 로 노출 */}
      {process.env.NEXT_PUBLIC_ENABLE_PUSH === "true" && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.13 }} className="mt-3">
          <NotificationCard permission={permission} subscription={subscription} subscribe={subscribe} unsubscribe={unsubscribe} onShowPwaGuide={() => setShowPwaGuide(true)} />
        </motion.div>
      )}

      {/* 알림 종류별 설정 (네이티브 앱 전용 — 컴포넌트 내부 isNative 가드) */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.13 }} className="mt-3">
        <NotificationPrefsCard />
      </motion.div>

      {/* 숏츠 표시 설정 (기기 로컬) */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.135 }} className="mt-3">
        <ShortsToggleCard />
      </motion.div>

      {/* 테마 설정 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14 }} className="mt-3">
        <ThemeToggleCard />
      </motion.div>

      {/* Menu items */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="mt-5">
        <MenuSection />
      </motion.div>

      {/* 피드백 보내기 */}
      {user && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.17 }} className="mt-3">
          <GlassCard pressable className="flex items-center justify-between p-5" onClick={() => setShowFeedback(true)}>
            <div className="flex items-center gap-4">
              <MessageSquareHeart size={22} className="text-text-secondary" />
              <span className="text-base text-text-primary">📮 피드백 보내기</span>
            </div>
            <ChevronRight size={22} className="text-text-tertiary" />
          </GlassCard>
        </motion.div>
      )}


      {/* Logged in info */}
      {user && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="mt-5">
          <GlassCard className="flex flex-col items-center gap-3 py-6">
            <p className="text-sm text-green-400">✅ 로그인 완료</p>
            <p className="text-xs text-text-tertiary">{user.email}</p>
            <div className="flex gap-3">
              <button onClick={() => signOut()} className="rounded-full bg-bg-tertiary px-8 py-2.5 text-sm font-semibold text-text-secondary">
                로그아웃
              </button>
              <button onClick={() => setShowDeleteAccount(true)} className="rounded-full px-6 py-2.5 text-sm font-semibold text-red-400 hover:text-red-300">
                계정 삭제
              </button>
            </div>
          </GlassCard>
        </motion.div>
      )}

      {/* Modals */}
      <TeamSelectModal isOpen={showTeamSelect} onSelect={handleTeamChange} />
      <PwaGuideModal isOpen={showPwaGuide} onClose={() => setShowPwaGuide(false)} />
      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      <FeedbackSheet isOpen={showFeedback} onClose={() => setShowFeedback(false)} />
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
      <DeleteAccountSheet
        isOpen={showDeleteAccount}
        onClose={() => setShowDeleteAccount(false)}
      />
    </div>
  );
}
