"use client";

import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS } from "@/lib/constants/teams";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useEffect } from "react";

// Google Ads 전환 ID/라벨 (analytics.ts GADS_CONVERSION_MAP과 동일)
const GADS_CONVERSION_SEND_TO = "AW-18082281693/-AI9CJa8l5ocEN3xpq5D";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input.trim().toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default function WelcomePage() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();

  // 프로필 없으면 홈으로 (직접 URL 진입 방지)
  useEffect(() => {
    if (!loading && (!user || !profile?.nickname || !profile?.team_id)) {
      router.replace("/");
    }
  }, [loading, user, profile, router]);

  // Google Ads conversion: /welcome 도달 시 직접 gtag 호출 (2026-04-27, 2026-04-29 재적용)
  // 조건: 1) AuthContext 로딩 완료 2) signup 플래그 존재 3) sessionStorage dedupe
  // loading 가드로 user?.email이 확실히 세팅된 후 발화 → Enhanced Conversions 데이터 보장
  useEffect(() => {
    if (loading) return; // AuthContext 로딩 완료 대기 — user_data 없이 발화 방지

    const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    if (!gtag) return;

    try {
      // 가드 1: /setup에서 가입 직후 리다이렉트된 세션인지 확인
      if (!sessionStorage.getItem("kbo-signup-just-completed")) return;
      // 가드 2: 이미 이 세션에서 발화했으면 skip
      if (sessionStorage.getItem("gads_sent_onboarding_complete")) return;

      // 플래그 정리 + dedupe 세팅 (conversion 발화 전에 세팅하여 중복 방지)
      sessionStorage.removeItem("kbo-signup-just-completed");
      sessionStorage.setItem("gads_sent_onboarding_complete", "1");

      // Enhanced Conversions: user_data 세팅 완료 후 conversion 발화 (순서 보장)
      (async () => {
        if (user?.email) {
          try {
            const hashed = await sha256Hex(user.email);
            gtag("set", "user_data", { sha256_email_address: hashed });
          } catch { /* hash 실패 시 skip — 기본 전환은 계속 진행 */ }
        }
        gtag("event", "conversion", {
          send_to: GADS_CONVERSION_SEND_TO,
          value: 1.0,
          currency: "KRW",
        });
      })();
    } catch { /* sessionStorage 접근 실패 — skip */ }
  }, [loading, user]);

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
