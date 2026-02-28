"use client";

import { motion } from "framer-motion";
import { Settings, ChevronRight, FileText, MessageCircle, Heart, Trophy } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";

export default function MyPage() {
  return (
    <div className="mx-auto max-w-lg px-5">
      <header className="flex items-center justify-between py-5">
        <h1 className="text-xl font-bold text-text-primary">MY</h1>
        <button className="rounded-full p-2 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <Settings size={24} />
        </button>
      </header>

      {/* Login prompt (guest state) */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <GlassCard className="flex flex-col items-center gap-4 py-8">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-bg-tertiary text-3xl">
            👤
          </div>
          <div className="text-center">
            <p className="text-base text-text-secondary">로그인하고 크보 에브리데이를 즐겨보세요!</p>
          </div>
          <button className="rounded-full bg-accent px-8 py-2.5 text-base font-semibold text-white">
            로그인
          </button>
        </GlassCard>
      </motion.div>

      {/* Mock logged-in profile preview */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-5"
      >
        <GlassCard className="p-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-bg-tertiary text-2xl">
              ⚾
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold text-text-primary">엘지골드</span>
                <TeamBadge teamId={1} />
              </div>
              <LevelBadge level={15} showTitle />
              <p className="mt-0.5 text-base text-text-tertiary">1,234 포인트</p>
            </div>
          </div>
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
        ].map(({ icon: Icon, label, count, detail }) => (
          <GlassCard key={label} pressable className="flex items-center justify-between p-5">
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
    </div>
  );
}
