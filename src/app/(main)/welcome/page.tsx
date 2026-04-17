"use client";

import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS } from "@/lib/constants/teams";
import { trackEvent, OnboardingEvents } from "@/lib/analytics";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useEffect } from "react";

export default function WelcomePage() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();

  // 프로필 없으면 홈으로 (직접 URL 진입 방지)
  useEffect(() => {
    if (!loading && (!user || !profile?.nickname || !profile?.team_id)) {
      router.replace("/");
    }
  }, [loading, user, profile, router]);

  // Google Ads 회원가입 전환 이벤트 — /welcome 도달 = 진짜 가입 완료 시점, 유저당 1회만
  useEffect(() => {
    if (loading || !user?.id || !profile?.nickname || !profile?.team_id) return;
    try {
      const firedKey = `gads_signup_fired_${user.id}`;
      if (localStorage.getItem(firedKey)) return;
      localStorage.setItem(firedKey, "1");
      trackEvent(
        OnboardingEvents.ONBOARDING_COMPLETE,
        { team_id: profile.team_id, user_id: user.id, source: "welcome_page" },
        { gads: true }
      );
    } catch {
      // localStorage 접근 실패 시 중복 우려 있지만 측정 누락보다는 허용
    }
  }, [loading, user?.id, profile?.nickname, profile?.team_id]);

  // 회원가입 완료 전환 이벤트는 /setup POST 성공 시 단일 경로에서만 발화
  // (중복 집계 방지 — GA4/Meta/Google Ads 모두 /setup에서 1회만)

  if (loading || !profile?.team_id) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const team = TEAMS.find((t) => t.id === profile.team_id);
  if (!team) {
    router.replace("/");
    return null;
  }

  return (
    <div className="min-h-screen bg-bg-primary flex flex-col items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-sm text-center"
      >
        {/* 팀 로고 */}
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
          className="w-24 h-24 rounded-full bg-white p-3 flex items-center justify-center mx-auto mb-6 shadow-lg"
          style={{ boxShadow: `0 0 40px ${team.colorPrimary}30` }}
        >
          <Image
            src={team.logoPath}
            alt={team.name}
            width={64}
            height={64}
            unoptimized
            className="object-contain"
          />
        </motion.div>

        {/* 환영 메시지 */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          <h1 className="text-2xl font-bold text-text-primary mb-2">
            가입 완료! 🎉
          </h1>
          <p className="text-lg text-text-secondary mb-1">
            <span style={{ color: team.colorLight }} className="font-bold">
              {profile.nickname}
            </span>
            님, 환영합니다
          </p>
          <p className="text-sm text-text-tertiary mb-8">
            {team.name} 팬으로 등록되었습니다
          </p>
        </motion.div>

        {/* CTA 버튼 */}
        <motion.button
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          onClick={() => router.replace("/")}
          className="w-full py-4 rounded-2xl font-bold text-white text-base transition-all active:scale-[0.98]"
          style={{ backgroundColor: team.colorPrimary }}
        >
          개인화된 홈으로 가기
        </motion.button>

        {/* 안내 텍스트 */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
          className="text-xs text-text-tertiary mt-4"
        >
          내 팀 경기 · 최애선수 · 커뮤니티가 준비되어 있어요
        </motion.p>
      </motion.div>
    </div>
  );
}
