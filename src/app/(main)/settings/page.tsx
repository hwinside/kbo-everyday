"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Download, MessageSquareHeart, Sparkles } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { isNative } from "@/lib/capacitor/platform";
import { usePushNotification } from "@/lib/hooks/usePushNotification";
import { useAuth } from "@/lib/supabase/AuthContext";
import FeedbackSheet from "@/components/feedback/FeedbackSheet";
import NotificationCard from "@/components/my/NotificationCard";
import NotificationPrefsCard from "@/components/my/NotificationPrefsCard";
import LockScreenCard from "@/components/my/LockScreenCard";
import WidgetTapModeCard from "@/components/my/WidgetTapModeCard";
import ThemeToggleCard from "@/components/my/ThemeToggleCard";
import HomeSectionsCard from "@/components/my/HomeSectionsCard";
import NewsPrefsCard from "@/components/my/NewsPrefsCard";
import PwaGuideModal from "@/components/my/PwaGuideModal";
import DeleteAccountSheet from "@/components/my/DeleteAccountSheet";
import FaqCard from "@/components/my/FaqCard";

export default function SettingsPage() {
  const router = useRouter();
  const goBack = useSafeBack("/my");
  const { user, signOut } = useAuth();
  const { permission, subscription, subscribe, unsubscribe } = usePushNotification();
  const [showPwaGuide, setShowPwaGuide] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);

  return (
    <div className="mx-auto max-w-lg px-5 pb-24">
      <div className="sticky top-0 z-30 border-b -mx-5 px-5 bg-bg-primary" style={{ borderColor: "var(--color-border)", paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <header className="min-h-[44px] flex items-center gap-3">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors"><ChevronLeft size={24} /></button>
          <h1 className="text-lg font-semibold leading-[26px] text-text-primary flex-1">설정</h1>
        </header>
      </div>

      {/* 알림 설정 — 실제 알림 트리거(경기시작·득점) 구현+QA 완료 전까지 숨김. NEXT_PUBLIC_ENABLE_PUSH=true 로 노출 */}
      {process.env.NEXT_PUBLIC_ENABLE_PUSH === "true" && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-4">
          <NotificationCard permission={permission} subscription={subscription} subscribe={subscribe} unsubscribe={unsubscribe} onShowPwaGuide={() => setShowPwaGuide(true)} />
        </motion.div>
      )}

      {/* 알림 종류별 설정 (네이티브=전체 토글 / 웹·PWA=뉴스클리핑 토글만 — 컴포넌트 내부 가드) */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-4">
        <NotificationPrefsCard />
      </motion.div>

      {/* 잠금화면 설정 (네이티브 전용 — 실시간 중계 토글·카드 스타일·다시 표시, 컴포넌트 내부 가드) */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="mt-3">
        <LockScreenCard />
      </motion.div>

      {/* 위젯 탭 동작 (안드 네이티브 전용 — 앱 열기 / 새로고침만, 컴포넌트 내부 가드) */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.07 }} className="mt-3">
        <WidgetTapModeCard />
      </motion.div>

      {/* 홈 화면 섹션 구성 (기기 로컬) — 숏츠 포함 6섹션 on/off */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }} className="mt-3">
        <HomeSectionsCard />
      </motion.div>

      {/* 뉴스 설정 (기기 로컬) — 사진기사 숨김 토글 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mt-3">
        <NewsPrefsCard />
      </motion.div>

      {/* 테마 설정 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }} className="mt-3">
        <ThemeToggleCard />
      </motion.div>

      {/* 도움말 · 앱 정보 */}
      <h2 className="mt-6 mb-2 px-1 text-sm font-semibold text-text-tertiary">도움말 · 앱 정보</h2>

      {/* 반복 CS를 바탕으로 정리한 FAQ — 기본은 접힌 상태 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14 }}>
        <FaqCard />
      </motion.div>

      {/* FAQ에서 답을 찾지 못한 로그인 유저가 바로 문의하도록 연결 */}
      {user && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="mt-2">
          <GlassCard pressable className="flex min-h-12 items-center justify-between !px-4 !py-0" onClick={() => setShowFeedback(true)}>
            <div className="flex items-center gap-3">
              <MessageSquareHeart size={20} className="text-text-secondary" />
              <span className="text-base text-text-primary">찾는 답변이 없나요?</span>
            </div>
            <ChevronRight size={20} className="text-text-tertiary" />
          </GlassCard>
        </motion.div>
      )}

      {/* 새 소식 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.16 }} className="mt-3">
        <GlassCard pressable className="flex items-center justify-between p-5" onClick={() => router.push("/whats-new")}>
          <div className="flex items-center gap-4">
            <Sparkles size={22} className="text-text-secondary" />
            <span className="text-base text-text-primary">새 소식</span>
          </div>
          <ChevronRight size={22} className="text-text-tertiary" />
        </GlassCard>
      </motion.div>

      {/* 앱 설치 — 네이티브 앱에선 불필요 */}
      {typeof window !== "undefined" && !isNative && !window.matchMedia("(display-mode: standalone)").matches && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }} className="mt-3">
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

      {/* 계정 */}
      {user && (
        <>
          <h2 className="mt-6 mb-2 px-1 text-sm font-semibold text-text-tertiary">계정</h2>
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
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
        </>
      )}

      {/* Modals */}
      <PwaGuideModal isOpen={showPwaGuide} onClose={() => setShowPwaGuide(false)} />
      <FeedbackSheet isOpen={showFeedback} onClose={() => setShowFeedback(false)} />
      <DeleteAccountSheet
        isOpen={showDeleteAccount}
        onClose={() => setShowDeleteAccount(false)}
      />
    </div>
  );
}
